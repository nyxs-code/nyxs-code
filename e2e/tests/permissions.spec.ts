import { test, expect, sendPrompt, readFakeFile, WORKSPACE } from "../fixtures";

const writeHello = { tools: [{ name: "Write", args: { file_path: `${WORKSPACE}/hello.txt`, content: "hola\n" } }] };

test.describe("Manual mode", () => {
  test("an edit waits for approval and runs once allowed", async ({ page, app, model }) => {
    await app();
    model.queue(writeHello, { text: "Archivo creado." });

    await sendPrompt(page, "Crea hello.txt");
    const card = page.getByRole("alertdialog", { name: "Allow this action?" });
    await expect(card).toContainText(`${WORKSPACE}/hello.txt`);
    expect(await readFakeFile(page, "hello.txt")).toBeUndefined();

    await card.getByRole("button", { name: "Allow once" }).click();

    await expect(page.getByText("Archivo creado.")).toBeVisible();
    expect(await readFakeFile(page, "hello.txt")).toBe("hola\n");
    expect(model.lastToolResults().join("\n")).toContain("OK: wrote");
  });

  test("a rejected edit is not applied and the model is told", async ({ page, app, model }) => {
    await app();
    model.queue(writeHello, { text: "Entendido, no lo creo." });

    await sendPrompt(page, "Crea hello.txt");
    await page.getByRole("alertdialog", { name: "Allow this action?" }).getByRole("button", { name: "Reject" }).click();

    await expect(page.getByText("Entendido, no lo creo.")).toBeVisible();
    expect(await readFakeFile(page, "hello.txt")).toBeUndefined();
    expect(model.lastToolResults().join("\n")).toMatch(/denied|rejected/i);
  });
});

test("Accept edits mode applies an edit without asking", async ({ page, app, model }) => {
  await app({ permissionMode: "acceptEdits", files: { "app.ts": "export const greeting = 'hello';\n" } });
  model.queue(
    { tools: [{ name: "Read", args: { file_path: `${WORKSPACE}/app.ts` } }] },
    { tools: [{ name: "Edit", args: { file_path: `${WORKSPACE}/app.ts`, old_string: "'hello'", new_string: "'hola'" } }] },
    { text: "Saludo traducido." },
  );

  await sendPrompt(page, "Traduce el saludo");

  await expect(page.getByText("Saludo traducido.")).toBeVisible();
  await expect(page.getByRole("alertdialog", { name: "Allow this action?" })).toHaveCount(0);
  expect(await readFakeFile(page, "app.ts")).toBe("export const greeting = 'hola';\n");
});

test("Plan mode refuses edits without asking", async ({ page, app, model }) => {
  await app({ permissionMode: "plan" });
  model.queue(writeHello, { text: "Primero el plan." });

  await sendPrompt(page, "Crea hello.txt");

  await expect(page.getByText("Primero el plan.")).toBeVisible();
  await expect(page.getByRole("alertdialog", { name: "Allow this action?" })).toHaveCount(0);
  expect(await readFakeFile(page, "hello.txt")).toBeUndefined();
  expect(model.lastToolResults().join("\n")).toContain("plan mode is active");
});
