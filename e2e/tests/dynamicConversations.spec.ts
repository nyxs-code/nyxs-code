import { test, expect, sendPrompt } from "../fixtures";

test("older messages out of view aren't drawn, but stay in the page", async ({ page, app, model }) => {
  await app();
  for (let i = 1; i <= 3; i++) {
    model.queue({ text: `Reply number ${i}.` });
    await sendPrompt(page, `Question number ${i}`);
    await expect(page.getByText(`Reply number ${i}.`)).toBeVisible();
  }
  // Six messages: the two oldest are lazy, the last four always drawn.
  await expect(page.locator(".chat-row-lazy")).toHaveCount(2);
  await expect(page.locator(".chat-row-lazy").first()).toContainText("Question number 1");
  await expect(page.getByText("Reply number 3.")).toBeVisible();
  // Still in the page: found by its text.
  await expect(page.getByText("Question number 1", { exact: true })).toHaveCount(1);
});
