import { chromium, type FullConfig } from "@playwright/test";

// Loads the app once before the first test. A fresh E2E server makes Vite crawl and pre-bundle
// the app's dependencies on the first page load, which on a busy machine (several sessions
// running the suite at once) took longer than a test's 45 s, so whatever test ran first timed
// out on the splash screen. The tests then start against a warm server.
export default async function warmup(config: FullConfig): Promise<void> {
  const { baseURL, channel } = config.projects[0].use;
  if (!baseURL) return;
  const browser = await chromium.launch({ channel });
  try {
    const page = await browser.newPage();
    // Without a session the app stops at its sign-in screen: enough to have loaded every module.
    await page.goto(baseURL, { waitUntil: "load", timeout: 180_000 });
    await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, { timeout: 180_000 });
  } finally {
    await browser.close();
  }
}
