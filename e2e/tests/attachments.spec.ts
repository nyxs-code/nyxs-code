import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, sendPrompt } from "../fixtures";
import type { Page } from "@playwright/test";

const composer = (page: Page) => page.getByRole("textbox", { name: /^(Type your coding request…|Type \/ for commands)$/ });
const chip = (page: Page, name: string) => page.locator(`p[data-tooltip="${name}"]`);

/** What the model got from the user in its latest request. */
const lastUserText = (model: { requests: { messages: { role: string; content: unknown }[] }[] }) =>
  model.requests.at(-1)!.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content)).join("\n");

/** A file handed to the page the way a drop or a paste does, with a DataTransfer. */
async function transfer(page: Page, kind: "drop" | "paste", name: string, text: string) {
  await page.evaluate(
    ({ kind, name, text }) => {
      const data = new DataTransfer();
      data.items.add(new File([text], name, { type: "text/plain" }));
      if (kind === "paste") {
        const box = document.querySelector<HTMLTextAreaElement>("textarea")!;
        box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      } else {
        window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }));
        window.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      }
    },
    { kind, name, text },
  );
}

test("a file picked, dropped or pasted shows as a chip and reaches the model", async ({ page, app, model }) => {
  await app();
  model.queue({ text: "Leídos los tres." });

  await page.locator('input[type="file"]').setInputFiles({ name: "picked.md", mimeType: "text/markdown", buffer: Buffer.from("# Elegido\n") });
  await transfer(page, "drop", "dropped.txt", "soltado aquí");
  await transfer(page, "paste", "pasted.txt", "pegado aquí");
  for (const name of ["picked.md", "dropped.txt", "pasted.txt"]) await expect(chip(page, name)).toBeVisible();

  await composer(page).fill("Lee los adjuntos");
  await composer(page).press("Enter");
  await expect(page.getByText("Leídos los tres.")).toBeVisible();

  const sent = lastUserText(model);
  expect(sent).toContain('<attached-file name=\\"picked.md\\"');
  expect(sent).toContain("# Elegido");
  expect(sent).toContain("soltado aquí");
  expect(sent).toContain("pegado aquí");
});

test("a file over 50 MB isn't read, and the model is told why", async ({ page, app, model }) => {
  // A sparse file on disk: Playwright hands the browser the path, nothing is copied. Deleted
  // after the test, passed or not.
  const dir = mkdtempSync(path.join(tmpdir(), "nyxs-e2e-"));
  try {
    const file = path.join(dir, "video.bin");
    const fd = openSync(file, "w");
    ftruncateSync(fd, 51 * 1024 * 1024);
    closeSync(fd);

    await app();
    model.queue({ text: "Demasiado grande." });
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(chip(page, "video.bin")).toBeVisible();
    await sendPrompt(page, "Mira el vídeo");
    await expect(page.getByText("Demasiado grande.")).toBeVisible();

    const sent = lastUserText(model);
    expect(sent).toContain('<attached-file name=\\"video.bin\\"');
    expect(sent).toMatch(/over the 50 MB limit, so it wasn't read or saved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
