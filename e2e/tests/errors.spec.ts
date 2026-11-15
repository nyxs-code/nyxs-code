import { test, expect, sendPrompt } from "../fixtures";

test("a provider error is shown and the chat stays usable", async ({ page, app, model }) => {
  await app();
  model.queue({ error: { status: 401, message: "Invalid API key (e2e)" } }, { text: "Ahora sí." });

  await sendPrompt(page, "Primera");
  await expect(page.getByText(/Invalid API key \(e2e\)/).first()).toBeVisible();

  // The turn ended: the next prompt goes through.
  await sendPrompt(page, "Segunda");
  await expect(page.getByText("Ahora sí.")).toBeVisible();
});
