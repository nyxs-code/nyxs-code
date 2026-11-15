import { test, expect, sendPrompt } from "../fixtures";

// The branch's commits change 10/2 lines in a.ts; not committed yet: 2/1 more in a.ts and 4/0 in b.ts.
const repo = {
  branch: "feature/login",
  prNumber: 7,
  ahead: 0,
  changes: {
    committed: [{ path: "src/a.ts", added: 10, removed: 2 }],
    uncommitted: [
      { path: "src/a.ts", added: 2, removed: 1 },
      { path: "src/b.ts", added: 4, removed: 0 },
    ],
  },
};

test("the Git bar's +N −M opens those changes, and the panel switches between the branch and uncommitted work", async ({ page, app }) => {
  await app({ repo });
  await sendPrompt(page, "Hola");
  await expect(page.getByText("OK", { exact: true })).toBeVisible();

  // All the branch's changes, like Claude Desktop: 16 added, 3 removed.
  const barCounts = page.getByRole("button", { name: "View changes" });
  await expect(barCounts).toHaveText("+16-3");
  await barCounts.click();

  const compare = page.getByRole("radiogroup", { name: "Compare" });
  await expect(compare.getByRole("radio", { name: "All branch changes" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("16 lines added, 3 removed")).toBeVisible();

  // Only what isn't committed: the panel and the bar both switch.
  await compare.getByRole("radio", { name: "Uncommitted" }).click();
  await expect(compare.getByRole("radio", { name: "Uncommitted" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("6 lines added, 1 removed")).toBeVisible();
  await expect(barCounts).toHaveText("+6-1");

  // The choice stays with the project: closing the panel and opening it again from the bar
  // keeps it, and it's saved for the folder.
  await page.getByRole("button", { name: "Close" }).last().click();
  await barCounts.click();
  await expect(page.getByRole("radiogroup", { name: "Compare" }).getByRole("radio", { name: "Uncommitted" })).toHaveAttribute("aria-checked", "true");
  const saved = await page.evaluate(() => localStorage.getItem("optimicer.diffMode.v1"));
  expect(JSON.parse(saved ?? "{}")).toEqual({ "c:/e2e/project": "uncommitted" });
});
