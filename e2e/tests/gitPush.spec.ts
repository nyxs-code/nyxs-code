import { test, expect, sendPrompt, backendCalls } from "../fixtures";

const repo = { branch: "feature/login", prNumber: 42, ahead: 2 };
const pushes = async (page: import("@playwright/test").Page) =>
  (await backendCalls(page, "agent_git")).filter((c) => (c.args as string[]).includes("push"));

test("Push sends the open PR's unpushed commits without an agent turn", async ({ page, app, model }) => {
  await app({ repo });
  await sendPrompt(page, "Hola");
  await expect(page.getByText("OK", { exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: "View PR" })).toBeVisible();
  const push = page.getByRole("button", { name: "Push (2)" });
  await expect(push).toBeVisible();
  const turnsBefore = model.requests.length;
  await push.click();

  await expect(push).toHaveCount(0);
  expect(await pushes(page)).toHaveLength(1);
  expect(model.requests.length).toBe(turnsBefore);
});

test("a push the remote turns away offers to pull, then pushes", async ({ page, app }) => {
  await app({ repo: { ...repo, remoteMoved: true } });
  await sendPrompt(page, "Hola");
  await page.getByRole("button", { name: "Push (2)" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The remote branch has commits you don't have yet");
  await alert.getByRole("button", { name: "Pull and push" }).click();

  await expect(page.getByRole("button", { name: "Push (2)" })).toHaveCount(0);
  const calls = (await backendCalls(page, "agent_git")).map((c) => (c.args as string[]).filter((a) => a !== "--no-optional-locks")[0]);
  expect(calls.filter((c) => c === "push" || c === "pull")).toEqual(["push", "pull", "push"]);
});
