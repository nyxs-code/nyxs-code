import { test, expect, sendPrompt, readFakeFile, backendCalls } from "../fixtures";

test("a Claude Code turn streams its text, shows its tool call and asks before writing", async ({ page, app }) => {
  await app({ claudeCode: true });
  await sendPrompt(page, "Crea claude.txt");

  // The CLI asks to use Write: the chat's permission card answers it.
  const card = page.getByRole("alertdialog", { name: "Allow this action?" });
  await expect(card).toContainText("claude.txt");
  await expect(page.getByText("Creo el archivo.")).toBeVisible();
  expect(await readFakeFile(page, "claude.txt")).toBeUndefined();
  await card.getByRole("button", { name: "Allow once" }).click();

  await expect(page.getByText("Listo, archivo creado.")).toBeVisible();
  expect(await readFakeFile(page, "claude.txt")).toBe("hecho por claude\n");

  // The app started the CLI with the picked model and answered the request with "allow".
  const started = (await backendCalls(page, "claude_code_start"))[0].request as Record<string, unknown>;
  expect(started.model).toBe("sonnet");
  const answers = (await backendCalls(page, "claude_code_send"))
    .map((c) => JSON.parse(String(c.line)) as Record<string, unknown>)
    .filter((m) => m.type === "control_response");
  expect(answers.some((m) => JSON.stringify(m).includes('"behavior":"allow"'))).toBe(true);
});

test("rejecting Claude Code's request leaves the file unwritten", async ({ page, app }) => {
  await app({ claudeCode: true });
  await sendPrompt(page, "Crea claude.txt");
  await page.getByRole("alertdialog", { name: "Allow this action?" }).getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("De acuerdo, no lo creo.")).toBeVisible();
  expect(await readFakeFile(page, "claude.txt")).toBeUndefined();
});
