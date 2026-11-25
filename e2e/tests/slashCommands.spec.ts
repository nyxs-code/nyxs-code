import { test, expect, sendPrompt } from "../fixtures";

const box = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: /^(Type your coding request…|Type \/ for commands)$/ });
const menuRows = (page: import("@playwright/test").Page) => page.locator("[data-composer-menu] button");

test("the / menu filters as you type and /clear empties the chat", async ({ page, app, model }) => {
  await app();
  model.queue({ text: "Respuesta para borrar." });
  await sendPrompt(page, "Hola");
  await expect(page.getByText("Respuesta para borrar.")).toBeVisible();

  await box(page).fill("/");
  await expect(menuRows(page).filter({ hasText: /^clear$/ })).toBeVisible();
  await box(page).fill("/cle");
  await expect(menuRows(page)).toHaveText(["clear"]);

  await menuRows(page).filter({ hasText: /^clear$/ }).click();
  await expect(box(page)).toHaveValue(/^\/clear\s*$/);
  await box(page).press("Enter");

  await expect(page.getByText("Respuesta para borrar.")).toHaveCount(0);
  await expect(page.getByText("Hola", { exact: true })).toHaveCount(0);
  // A builtin runs in the app: the model wasn't asked anything.
  expect(model.requests).toHaveLength(1);
});

test("a prompt command sends its text, with the arguments filled in", async ({ page, app, model }) => {
  await app();
  model.queue({ text: "Commit hecho." });
  await sendPrompt(page, "/commit solo los tests");
  await expect(page.getByText("Commit hecho.")).toBeVisible();

  const sent = model.requests.at(-1)!.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content)).join("\n");
  expect(sent).toContain("Create a git commit for the current changes.");
  expect(sent).toContain("solo los tests");
  // The chat shows what the user typed, not the expanded instructions. (The sidebar may name the
  // session after it too, until its title comes back.)
  const chat = page.locator("main");
  await expect(chat.getByText("/commit solo los tests")).toBeVisible();
  await expect(page.getByText("Create a git commit for the current changes.")).toHaveCount(0);
});
