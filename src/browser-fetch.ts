const BROWSER_TIMEOUT = 30_000; // 30s for SPA rendering
const RENDER_POLL_INTERVAL = 500; // check content every 500ms

// Chromium args to reduce headless detection by anti-bot systems
const STEALTH_ARGS = [
	'--disable-blink-features=AutomationControlled',
];

/**
 * Fetch a page using a headless browser (Playwright) to execute JavaScript.
 * This is used as a fallback for SPAs that render content client-side.
 * Playwright must be installed separately: `npm install playwright`
 */
export async function fetchPageWithBrowser(url: string, language?: string): Promise<string> {
	let chromium;
	try {
		// Dynamic require so the module loads fine when playwright isn't installed
		chromium = require('playwright').chromium;
	} catch {
		throw new Error(
			'Playwright is required for browser rendering but is not installed.\n' +
			'Install it with: npm install playwright'
		);
	}

	const browser = await chromium.launch({
		headless: true,
		args: STEALTH_ARGS,
	});
	try {
		const context = await browser.newContext({
			...(language ? { locale: language } : {}),
			userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
		});
		const page = await context.newPage();

		// Use 'domcontentloaded' instead of 'networkidle' because SPAs
		// often maintain persistent connections that prevent networkidle.
		await page.goto(url, {
			waitUntil: 'domcontentloaded',
			timeout: BROWSER_TIMEOUT,
		});

		// Wait for SPA content to render by polling for substantial text content.
		// Falls back to a fixed timeout if the page never produces content.
		await waitForContent(page, BROWSER_TIMEOUT);

		const html: string = await page.content();
		return html;
	} finally {
		await browser.close();
	}
}

/**
 * Poll the page until the body has a reasonable amount of text content,
 * or until the timeout is reached.
 */
async function waitForContent(page: any, timeout: number): Promise<void> {
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		const textLength: number = await page.evaluate(() => {
			return document.body?.innerText?.length ?? 0;
		});

		// 200 characters is a reasonable threshold for "content has rendered"
		if (textLength > 200) {
			return;
		}

		await page.waitForTimeout(RENDER_POLL_INTERVAL);
	}
}

/**
 * Check whether Playwright is available in the current environment.
 */
export function isPlaywrightAvailable(): boolean {
	try {
		require.resolve('playwright');
		return true;
	} catch {
		return false;
	}
}
