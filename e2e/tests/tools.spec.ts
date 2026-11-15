import { test, expect, sendPrompt, WORKSPACE } from "../fixtures";

test("Read sends the file's lines back to the model", async ({ page, app, model }) => {
  await app({ files: { "src/main.ts": "console.log('uno');\nconsole.log('dos');\n" } });
  model.queue({ tools: [{ name: "Read", args: { file_path: `${WORKSPACE}/src/main.ts` } }] }, { text: "Tiene dos líneas." });

  await sendPrompt(page, "¿Qué hace main.ts?");

  await expect(page.getByText("Tiene dos líneas.")).toBeVisible();
  const result = model.lastToolResults().join("\n");
  expect(result).toContain("console.log('uno');");
  expect(result).toContain("console.log('dos');");
});
