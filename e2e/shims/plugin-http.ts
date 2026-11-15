// Stand-in for @tauri-apps/plugin-http in the E2E build: the page's own fetch, which Playwright
// intercepts (see e2e/fixtures.ts).
export const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
