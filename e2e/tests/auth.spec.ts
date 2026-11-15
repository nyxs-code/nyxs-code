import { test, expect } from "../fixtures";

test("without a session it shows the sign-in screen and nothing else", async ({ page, app, model }) => {
  await app({ signedOut: true });

  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Type your coding request…" })).toHaveCount(0);
  expect(model.requests).toHaveLength(0);
});
