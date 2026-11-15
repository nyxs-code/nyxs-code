import { test, expect, sendPrompt, readFakeFile, WORKSPACE } from "../fixtures";

const writeNote = (content: string) => ({ tools: [{ name: "Write", args: { file_path: `${WORKSPACE}/notes.txt`, content } }] });
const card = (page: import("@playwright/test").Page) => page.getByRole("alertdialog", { name: "Allow this action?" });

test("\"Always allow\" isn't asked again for the same call, and is still there after a reload", async ({ page, app, model }) => {
  await app();
  model.queue(writeNote("uno\n"), { text: "Primera nota." }, writeNote("dos\n"), { text: "Segunda nota." });

  await sendPrompt(page, "Escribe la nota");
  await card(page).getByRole("button", { name: `Always allow ${WORKSPACE}/*` }).click();
  await expect(page.getByText("Primera nota.")).toBeVisible();
  expect(await readFakeFile(page, "notes.txt")).toBe("uno\n");

  // The same call again: it runs without a card.
  await sendPrompt(page, "Cámbiala");
  await expect(page.getByText("Segunda nota.")).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(await readFakeFile(page, "notes.txt")).toBe("dos\n");

  // The rule is kept with the account, so it holds after the app loads again.
  const rules = await page.evaluate(() =>
    Object.entries(localStorage).filter(([k]) => k.startsWith("optimicer.permissionRules.v1")).map(([, v]) => JSON.parse(v)),
  );
  expect(rules.flat()).toHaveLength(1);

  await page.goto("/");
  model.queue(writeNote("tres\n"), { text: "Tercera nota." });
  await sendPrompt(page, "Una más");
  await expect(page.getByText("Tercera nota.")).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(await readFakeFile(page, "notes.txt")).toBe("tres\n");
});
