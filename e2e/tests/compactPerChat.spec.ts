import { test, expect, sendPrompt } from "../fixtures";

const notice = (page: import("@playwright/test").Page) => page.getByText("Compacting the conversation");

test("/compact shows its divider only in the session it runs in", async ({ page, app, model }) => {
  await app();
  model.queue({ text: "Respuesta uno." }, { text: "Respuesta uno bis." }, { text: "Respuesta dos." });
  await sendPrompt(page, "Primera pregunta");
  await expect(page.getByText("Respuesta uno.")).toBeVisible();
  await sendPrompt(page, "Otra pregunta");
  await expect(page.getByText("Respuesta uno bis.")).toBeVisible();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await sendPrompt(page, "Segunda pregunta");
  await expect(page.getByText("Respuesta dos.")).toBeVisible();

  // The summary is a request without tools; hold it so the compaction stays running.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let holding = true;
  await page.route("**/chat/completions", async (route) => {
    const body = route.request().postDataJSON();
    if (holding && !(Array.isArray(body?.tools) && body.tools.length > 0)) await held;
    await route.fallback();
  });

  // The first session is the top row.
  const rows = page.getByRole("button", { name: /^Sesión de prueba/ });
  await rows.first().click();
  await expect(page.getByText("Primera pregunta", { exact: true })).toBeVisible();
  // The first Enter picks the command from the / menu, the second sends it.
  await sendPrompt(page, "/compact");
  const box = page.getByRole("textbox", { name: "Type / for commands" });
  await expect(box).toHaveValue(/^\/compact\s*$/);
  await box.press("Enter");
  await expect(notice(page)).toBeVisible();

  await rows.nth(1).click();
  await expect(page.getByText("Segunda pregunta", { exact: true })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);

  await rows.first().click();
  await expect(notice(page)).toBeVisible();

  // It finishes while the other session is open, and leaves its finished divider in its own.
  await rows.nth(1).click();
  holding = false;
  release();
  await rows.first().click();
  await expect(page.getByText("Primera pregunta", { exact: true })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByText("Conversation compacted")).toBeVisible();

  await rows.nth(1).click();
  await expect(page.getByText("Conversation compacted")).toHaveCount(0);
});
