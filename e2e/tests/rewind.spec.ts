import { test, expect, sendPrompt, readFakeFile, WORKSPACE } from "../fixtures";
import type { Page } from "@playwright/test";

const ORIGINAL = "export const a = 1;\n";

/** One turn: the agent edits app.ts with its tools and creates notes.txt from the shell. */
const turn = [
  { tools: [{ name: "Read", args: { file_path: `${WORKSPACE}/app.ts` } }] },
  { tools: [{ name: "Edit", args: { file_path: `${WORKSPACE}/app.ts`, old_string: "a = 1", new_string: "a = 2" } }] },
  { tools: [{ name: "Bash", args: { command: "echo hola > notes.txt", description: "Write a note" } }] },
  { text: "Cambios hechos." },
];

/** Sends the prompt and lets the turn finish, allowing the shell command when it's asked. */
async function runTurn(page: Page, prompt: string) {
  await sendPrompt(page, prompt);
  const allow = page.getByRole("alertdialog", { name: "Allow this action?" }).getByRole("button", { name: "Allow once" });
  const done = page.getByText("Cambios hechos.");
  await expect(allow.or(done)).toBeVisible();
  if (await allow.isVisible()) await allow.click();
  await expect(done).toBeVisible();
  expect(await readFakeFile(page, "app.ts")).toBe("export const a = 2;\n");
  expect(await readFakeFile(page, "notes.txt")).toBe("hola\n");
}

async function openRewind(page: Page) {
  await page.getByText("Cambia a", { exact: true }).hover();
  await page.getByRole("button", { name: "Rewind to here" }).click();
  return page.getByRole("alertdialog", { name: "Go back to this message?" });
}

async function pickMode(page: Page, label: string) {
  const dialog = page.getByRole("alertdialog", { name: "Go back to this message?" });
  await dialog.getByRole("button", { name: "Code and conversation" }).click();
  await dialog.getByRole("option", { name: label }).click();
}

test.beforeEach(async ({ app, model }) => {
  await app({ permissionMode: "acceptEdits", files: { "app.ts": ORIGINAL } });
  model.queue(...turn);
});

test("the rewind dialog lists the files the agent and its shell changed, and both come back with the conversation", async ({ page }) => {
  await runTurn(page, "Cambia a");
  const dialog = await openRewind(page);

  // app.ts edited by the agent (−1 +1 to undo) and notes.txt created by a command (−1).
  await expect(dialog).toContainText("2 files");
  await expect(dialog).toContainText("+1");
  await expect(dialog).toContainText("−2");
  await expect(dialog.getByRole("listitem")).toHaveText(["app.ts", "notes.txt"]);

  await dialog.getByRole("button", { name: "Rewind" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => readFakeFile(page, "app.ts")).toBe(ORIGINAL);
  expect(await readFakeFile(page, "notes.txt")).toBeUndefined();
  await expect(page.getByText("Cambios hechos.")).toHaveCount(0);
  // The prompt goes back in the box to be sent again.
  await expect(page.getByRole("textbox", { name: /^(Type your coding request…|Type \/ for commands)$/ })).toHaveValue("Cambia a");
});

test("\"Code only\" restores the files and keeps the conversation", async ({ page }) => {
  await runTurn(page, "Cambia a");
  await openRewind(page);
  await pickMode(page, "Code only");
  await page.getByRole("alertdialog", { name: "Go back to this message?" }).getByRole("button", { name: "Rewind" }).click();

  await expect.poll(() => readFakeFile(page, "app.ts")).toBe(ORIGINAL);
  expect(await readFakeFile(page, "notes.txt")).toBeUndefined();
  await expect(page.getByText("Cambios hechos.")).toBeVisible();
});

test("\"Conversation only\" removes the messages and leaves the files", async ({ page }) => {
  await runTurn(page, "Cambia a");
  await openRewind(page);
  await pickMode(page, "Conversation only");
  await page.getByRole("alertdialog", { name: "Go back to this message?" }).getByRole("button", { name: "Rewind" }).click();

  await expect(page.getByText("Cambios hechos.")).toHaveCount(0);
  expect(await readFakeFile(page, "app.ts")).toBe("export const a = 2;\n");
  expect(await readFakeFile(page, "notes.txt")).toBe("hola\n");
});
