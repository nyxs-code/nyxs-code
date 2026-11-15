import { expect, test } from "@playwright/test";

// Every update card in the changelog, and the sample, drawn in every language at the narrowest
// and the default sidebar, slide by slide and step by step, in each install state: nothing may
// be cut short or stick out of its frame (src/components/update/cardAudit.ts). A card that
// fails here would show users a clipped text.
test("update cards fit in every language", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // On a fresh E2E server Vite can re-bundle a dependency while the page loads; with HMR off
  // the page then stays blank instead of reloading itself. A reload gets the new bundle.
  for (let attempt = 1; ; attempt++) {
    await page.goto("/dev/update-card.html", { timeout: 90_000 });
    const ready = await page
      .waitForFunction(() => "__updateCard" in window, undefined, { timeout: 30_000 })
      .then(() => true, () => false);
    if (ready) break;
    if (attempt === 3) throw new Error(`the card harness never loaded${errors.length ? `: ${errors.join("; ")}` : ""}`);
  }
  const problems = await page.evaluate(() => (window as unknown as { __updateCard: { audit: () => Promise<string[]> } }).__updateCard.audit());
  expect(problems).toEqual([]);
});
