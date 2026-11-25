import { test, expect } from "../fixtures";

test("a shortcut changed in Keyboard shortcuts works at once, and the old keys stop", async ({ page, app }) => {
  await app();
  await page.getByRole("textbox", { name: /^(Type your coding request…|Type \/ for commands)$/ }).click();
  await page.keyboard.press("Control+/");
  const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(list).toBeVisible();
  if (process.env.SHORTCUTS_SHOTS) await list.screenshot({ path: `${process.env.SHORTCUTS_SHOTS}/1-list.png` });

  const pencil = list.getByRole("button", { name: "Change shortcut for Toggle settings" });
  await pencil.click();
  await expect(list.getByText("Press a shortcut")).toBeVisible();
  if (process.env.SHORTCUTS_SHOTS) await list.screenshot({ path: `${process.env.SHORTCUTS_SHOTS}/2-recording.png` });
  // Taken by Search sessions: it asks first.
  await page.keyboard.press("Control+k");
  await expect(list.getByText("Also used by Search sessions.")).toBeVisible();
  if (process.env.SHORTCUTS_SHOTS) await list.screenshot({ path: `${process.env.SHORTCUTS_SHOTS}/3-clash.png` });
  await page.keyboard.press("Control+Shift+g");
  await expect(list.getByRole("button", { name: "Reset Toggle settings to default" })).toBeVisible();
  await expect(list.getByText("Doesn’t work in the browser panel")).toBeVisible();
  if (process.env.SHORTCUTS_SHOTS) await list.screenshot({ path: `${process.env.SHORTCUTS_SHOTS}/4-changed.png` });

  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await page.getByRole("textbox", { name: /^(Type your coding request…|Type \/ for commands)$/ }).click();
  await page.keyboard.press("Control+,");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+g");
  await expect(page.getByRole("dialog").locator("nav button", { hasText: "Account" })).toBeVisible();
});
