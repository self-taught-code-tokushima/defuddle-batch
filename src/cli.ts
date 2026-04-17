#!/usr/bin/env node

import { Command } from 'commander';
import { Defuddle } from './node';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import { parseLinkedomHTML } from './utils/linkedom-compat';
import { countWords } from './utils';
import { getInitialUA, fetchPage, extractRawMarkdown, cleanMarkdownContent, BOT_UA } from './fetch';
import { fetchPageWithBrowser, isPlaywrightAvailable } from './browser-fetch';

interface ParseOptions {
	output?: string;
	markdown?: boolean;
	md?: boolean;
	json?: boolean;
	debug?: boolean;
	property?: string;
	lang?: string;
	render?: boolean;
}

interface BatchOptions {
	outputDir?: string;
	delay?: string;
	markdown?: boolean;
	md?: boolean;
	json?: boolean;
	debug?: boolean;
	lang?: string;
	render?: boolean;
}

interface CoreOptions {
	markdown?: boolean;
	json?: boolean;
	debug?: boolean;
	lang?: string;
	render?: boolean;
}

/**
 * Core URL parsing logic shared between `parse` and `batch` commands.
 * Returns the DefuddleResponse, or throws on fetch/parse errors.
 */
async function parseUrl(source: string, options: CoreOptions) {
	const defuddleOpts = {
		debug: options.debug,
		markdown: options.markdown,
		separateMarkdown: options.markdown || options.json,
		language: options.lang,
	};

	let html: string;

	if (options.render) {
		html = await fetchPageWithBrowser(source, options.lang);
	} else {
		const initialUA = getInitialUA(source);
		html = await fetchPage(source, initialUA, options.lang);
	}

	const doc = parseLinkedomHTML(html);
	let result = await Defuddle(doc, source, defuddleOpts);

	// If no content was extracted, retry with bot UA.
	if (!options.render && result.wordCount === 0) {
		try {
			const botHtml = await fetchPage(source, BOT_UA, options.lang);

			const rawMarkdown = extractRawMarkdown(botHtml);
			if (rawMarkdown) {
				const botDoc = parseLinkedomHTML(botHtml);
				const botResult = await Defuddle(botDoc, source, defuddleOpts);
				botResult.content = cleanMarkdownContent(rawMarkdown);
				botResult.wordCount = countWords(botResult.content);
				result = botResult;
			} else {
				const botDoc = parseLinkedomHTML(botHtml);
				const botResult = await Defuddle(botDoc, source, defuddleOpts);
				if (botResult.wordCount > 0) {
					result = botResult;
				}
			}
		} catch {
			// Bot UA may be blocked — use original result
		}
	}

	// If still no content and Playwright is available, try headless browser rendering.
	if (!options.render && result.wordCount === 0 && isPlaywrightAvailable()) {
		try {
			const browserHtml = await fetchPageWithBrowser(source, options.lang);
			const browserDoc = parseLinkedomHTML(browserHtml);
			const browserResult = await Defuddle(browserDoc, source, defuddleOpts);
			if (browserResult.wordCount > 0) {
				result = browserResult;
			}
		} catch {
			// Playwright rendering failed — use previous result
		}
	}

	return result;
}

/**
 * Format a DefuddleResponse into an output string.
 */
function formatResult(result: any, options: { markdown?: boolean; json?: boolean; property?: string }): string {
	if (options.property) {
		if (options.property in result) {
			return result[options.property as keyof typeof result]?.toString() || '';
		}
		throw new Error(`Property "${options.property}" not found in response`);
	}

	if (options.json) {
		return JSON.stringify({
			content: result.content,
			title: result.title,
			description: result.description,
			domain: result.domain,
			favicon: result.favicon,
			image: result.image,
			language: result.language,
			metaTags: result.metaTags,
			parseTime: result.parseTime,
			published: result.published,
			author: result.author,
			site: result.site,
			schemaOrgData: result.schemaOrgData,
			wordCount: result.wordCount,
			...(result.contentMarkdown ? { contentMarkdown: result.contentMarkdown } : {}),
			...(result.variables ? { variables: result.variables } : {}),
		}, null, 2);
	}

	return result.content;
}

/**
 * Generate a filename slug from a URL.
 */
function slugFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const pathParts = parsed.pathname.replace(/\/$/, '').split('/').filter(Boolean);
		const slug = pathParts.length > 0
			? pathParts[pathParts.length - 1]
			: parsed.hostname.replace(/\./g, '-');
		// Remove characters that are problematic in filenames
		return slug.replace(/[<>:"/\\|?*]/g, '-').replace(/-+/g, '-');
	} catch {
		return 'output';
	}
}

// ANSI color helpers (avoids chalk dependency which is ESM-only)
const useColor = process.stdout.isTTY ?? false;
const ansi = {
	red: (s: string) => useColor ? `\x1b[31m${s}\x1b[39m` : s,
	green: (s: string) => useColor ? `\x1b[32m${s}\x1b[39m` : s,
};

// Read version from package.json
const version = require('../package.json').version;

const program = new Command();

program
	.name('defuddle')
	.description('Extract article content from web pages')
	.version(version);

program
	.command('parse')
	.description('Parse HTML content from a file or URL')
	.argument('<source>', 'HTML file path or URL to parse')
	.option('-o, --output <file>', 'Output file path (default: stdout)')
	.option('-m, --markdown', 'Convert content to markdown format')
	.option('--md', 'Alias for --markdown')
	.option('-j, --json', 'Output as JSON with metadata and content')
	.option('-p, --property <name>', 'Extract a specific property (e.g., title, description, domain)')
	.option('--debug', 'Enable debug mode')
	.option('-l, --lang <code>', 'Preferred language (BCP 47, e.g. en, fr, ja)')
	.option('-r, --render', 'Use headless browser to render JavaScript (requires playwright)')
	.action(async (source: string, options: ParseOptions) => {
		try {
			// Handle --md alias
			if (options.md) {
				options.markdown = true;
			}

			let result;

			const isUrl = source.startsWith('http://') || source.startsWith('https://');
			if (isUrl) {
				result = await parseUrl(source, options);
			} else {
				const filePath = resolve(process.cwd(), source);
				const html = await readFile(filePath, 'utf-8');
				const doc = parseLinkedomHTML(html);
				result = await Defuddle(doc, undefined, {
					debug: options.debug,
					markdown: options.markdown,
					separateMarkdown: options.markdown || options.json,
					language: options.lang,
				});
			}

			// Check if parsing produced meaningful content
			const textContent = result.content.replace(/<[^>]*>/g, '').trim();
			if (!textContent) {
				console.error(ansi.red(`Error: No content could be extracted from ${source}`));
				process.exit(1);
			}

			const output = formatResult(result, options);

			// Handle output
			if (options.output) {
				const outputPath = resolve(process.cwd(), options.output);
				await writeFile(outputPath, output, 'utf-8');
				console.log(ansi.green(`Output written to ${options.output}`));
			} else {
				console.log(output);
			}
		} catch (error) {
			console.error(ansi.red('Error:'), error instanceof Error ? error.message : 'Unknown error occurred');
			process.exit(1);
		}
	});

program
	.command('batch')
	.description('Parse multiple URLs from a file with a delay between requests')
	.argument('<file>', 'Text file with one URL per line (# comments and empty lines are skipped)')
	.option('-o, --output-dir <dir>', 'Output directory (default: current directory)', '.')
	.option('-d, --delay <seconds>', 'Delay between requests in seconds (default: 1)', '1')
	.option('-m, --markdown', 'Convert content to markdown format')
	.option('--md', 'Alias for --markdown')
	.option('-j, --json', 'Output as JSON with metadata and content')
	.option('--debug', 'Enable debug mode')
	.option('-l, --lang <code>', 'Preferred language (BCP 47, e.g. en, fr, ja)')
	.option('-r, --render', 'Use headless browser to render JavaScript (requires playwright)')
	.action(async (file: string, options: BatchOptions) => {
		try {
			if (options.md) {
				options.markdown = true;
			}

			const filePath = resolve(process.cwd(), file);
			const content = await readFile(filePath, 'utf-8');
			const urls = content
				.split('\n')
				.map(line => line.trim())
				.filter(line => line && !line.startsWith('#'));

			if (urls.length === 0) {
				console.error(ansi.red('Error: No URLs found in file'));
				process.exit(1);
			}

			const outputDir = resolve(process.cwd(), options.outputDir || '.');
			await mkdir(outputDir, { recursive: true });

			const ext = options.json ? '.json' : options.markdown ? '.md' : '.html';
			const delayMs = Math.max(0, parseFloat(options.delay || '1') * 1000);

			// Track used filenames to avoid collisions
			const usedNames = new Set<string>();

			let succeeded = 0;
			let failed = 0;

			for (let i = 0; i < urls.length; i++) {
				const url = urls[i];
				const index = `[${i + 1}/${urls.length}]`;

				process.stderr.write(`${index} ${url} ... `);

				try {
					const result = await parseUrl(url, options);

					const textContent = result.content.replace(/<[^>]*>/g, '').trim();
					if (!textContent) {
						process.stderr.write(ansi.red('no content\n'));
						failed++;
					} else {
						const output = formatResult(result, { markdown: options.markdown, json: options.json });

						// Generate unique filename
						let baseName = slugFromUrl(url);
						let fileName = baseName + ext;
						let counter = 1;
						while (usedNames.has(fileName)) {
							fileName = `${baseName}-${counter}${ext}`;
							counter++;
						}
						usedNames.add(fileName);

						const outputPath = join(outputDir, fileName);
						await writeFile(outputPath, output, 'utf-8');
						process.stderr.write(ansi.green(`${fileName} (${result.wordCount} words)\n`));
						succeeded++;
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : 'Unknown error';
					process.stderr.write(ansi.red(`error: ${msg}\n`));
					failed++;
				}

				// Delay before next request (skip after last)
				if (i < urls.length - 1 && delayMs > 0) {
					await new Promise(r => setTimeout(r, delayMs));
				}
			}

			process.stderr.write(`\nDone: ${succeeded} succeeded, ${failed} failed\n`);
			if (failed > 0) {
				process.exit(1);
			}
		} catch (error) {
			console.error(ansi.red('Error:'), error instanceof Error ? error.message : 'Unknown error occurred');
			process.exit(1);
		}
	});

program.parse();
