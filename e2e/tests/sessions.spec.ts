import { test, expect, sendPrompt } from "../fixtures";

test("a new session starts empty and the earlier one can be reopened", async ({ page, app, model }) => {
  await app();
  model.queue({ text: "Respuesta de la primera sesión." });
  await sendPrompt(page, "Primera pregunta");
  await expect(page.getByText("Respuesta de la primera sesión.")).toBeVisible();

  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.getByText("Primera pregunta", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /^Sesión de prueba/ }).click();
  await expect(page.getByText("Primera pregunta", { exact: true })).toBeVisible();
  await expect(page.getByText("Respuesta de la primera sesión.")).toBeVisible();
});
