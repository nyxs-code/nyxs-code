import { test, expect } from "../fixtures";

type E2EWindow = { __E2E__: { metas: Map<string, string>; calls: { cmd: string; args: Record<string, unknown> }[] } };

test("Settings lists the sessions' worktrees and removes the chosen ones", async ({ page, app }) => {
  await app();
  await page.evaluate(() => {
    const metas = (window as unknown as E2EWindow).__E2E__.metas;
    metas.set("old-fox", JSON.stringify({ title: "Fix the pay button", worktree: { path: "C:/wt/old-fox", branch: "Nyxs/old-fox" } }));
    metas.set("calm-heron", JSON.stringify({ title: "Try the dark theme", worktree: { path: "C:/wt/calm-heron-dirty", branch: "Nyxs/calm-heron" } }));
  });
  await page.getByRole("textbox", { name: /^(Type your coding request…|Type \/ for commands)$/ }).click();
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog");
  await settings.locator("nav button", { hasText: "Nyxs Code" }).click();
  await expect(settings.getByText("2 worktrees · 6 GB.")).toBeVisible();
  await expect(settings.getByRole("button", { name: "Archive inactive sessions" })).toHaveText(/Never/);
  if (process.env.CLEANUP_SHOTS) {
    await settings.getByText("Session worktrees").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.CLEANUP_SHOTS}/1-settings.png` });
  }

  await settings.getByRole("button", { name: "Remove unused worktrees…" }).click();
  const cleanup = page.getByRole("dialog", { name: "Remove unused worktrees" });
  // Both were used today: only "Any" lists them.
  await expect(cleanup.getByText("No worktrees from sessions unused for 7 days.")).toBeVisible();
  await cleanup.getByRole("button", { name: "Time since last use" }).click();
  await page.getByRole("menuitemradio", { name: "Any" }).click();
  await expect(cleanup.getByRole("checkbox", { name: "Select Fix the pay button" })).toBeChecked();
  await expect(cleanup.getByRole("checkbox", { name: "Select Try the dark theme" })).not.toBeChecked();
  await expect(cleanup.getByText("2 uncommitted changes", { exact: false })).toBeVisible();
  if (process.env.CLEANUP_SHOTS) await page.screenshot({ path: `${process.env.CLEANUP_SHOTS}/2-dialog.png` });

  await cleanup.getByRole("button", { name: "Remove 1 worktree" }).click();
  await expect(cleanup.getByText("Removed the worktree of 1 session.")).toBeVisible();
  const removed = await page.evaluate(() =>
    (window as unknown as E2EWindow).__E2E__.calls.filter((c) => c.cmd === "session_worktree_remove").map((c) => c.args.path),
  );
  expect(removed).toEqual(["C:/wt/old-fox"]);
  await cleanup.getByRole("button", { name: "Close" }).last().click();
  await expect(settings.getByText("1 worktree · 3 GB.")).toBeVisible();
});
