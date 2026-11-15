import { test, expect, sendPrompt } from "../fixtures";

/** Two sessions with an answer each; the second one is open. */
async function twoSessions(page: import("@playwright/test").Page, model: import("../fixtures").FakeModel) {
  model.queue({ text: "Respuesta uno." }, { text: "Respuesta dos." });
  await sendPrompt(page, "Primera pregunta");
  await expect(page.getByText("Respuesta uno.")).toBeVisible();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await sendPrompt(page, "Segunda pregunta");
  await expect(page.getByText("Respuesta dos.")).toBeVisible();
}

const panes = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "Sesión de prueba" });
const composers = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "Type / for commands" });

test("a session opens to the side from its menu, and closing a pane goes back to one", async ({ page, app, model }) => {
  await app();
  await twoSessions(page, model);
  await expect(composers(page)).toHaveCount(1);

  // The first session is the top row; the open one (just created) is listed under it.
  const row = page.getByRole("button", { name: /^Sesión de prueba/ }).first();
  await row.hover();
  await row.locator("xpath=following-sibling::button[1]").click();
  await page.getByRole("button", { name: "Open to the side" }).click();

  await expect(panes(page)).toHaveCount(2);
  await expect(composers(page)).toHaveCount(2);
  await expect(page.getByText("Primera pregunta", { exact: true })).toBeVisible();
  await expect(page.getByText("Segunda pregunta", { exact: true })).toBeVisible();

  // A message from the left pane goes to its own session.
  model.queue({ text: "Respuesta tres." });
  await composers(page).first().fill("Tercera pregunta");
  await composers(page).first().press("Enter");
  await expect(panes(page).first().getByText("Respuesta tres.")).toBeVisible();
  await expect(panes(page).nth(1).getByText("Respuesta tres.")).toHaveCount(0);

  await panes(page).nth(1).getByRole("button", { name: "Close pane" }).click();
  await expect(composers(page)).toHaveCount(1);
  await expect(page.getByText("Segunda pregunta", { exact: true })).toBeVisible();
});

test("dragging a session onto the chat opens it to the side", async ({ page, app, model }) => {
  await app();
  await twoSessions(page, model);
  await page.getByRole("button", { name: /^Sesión de prueba/ }).first().dragTo(page.getByText("Segunda pregunta", { exact: true }));
  await expect(panes(page)).toHaveCount(2);
  await expect(page.getByText("Primera pregunta", { exact: true })).toBeVisible();
});
