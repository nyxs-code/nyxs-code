import { test, expect } from "../fixtures";

test("Settings › Account opens and shows the signed-in user", async ({ page, app }) => {
  await app();
  await page.getByRole("textbox", { name: /^(Type your coding request…|Type \/ for commands)$/ }).click();
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog");
  await dialog.locator("nav button", { hasText: "Account" }).click();
  await expect(dialog.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(dialog.getByText("e2e@nyxs.test")).toBeVisible();
  await expect(dialog.getByText("No active sessions.")).toBeVisible();
  // The page used to crash a moment after opening; make sure it stays up.
  await page.waitForTimeout(500);
  await expect(page.getByText("Something broke in the UI")).toHaveCount(0);
});
