import { test, expect } from "../fixtures";

const CHECK = /You check whether an AI coding agent/;

test("/goal keeps the agent working until the check finds the goal met", async ({ page, app, model }) => {
  await app();
  model.queue({ text: "I wrote the greeting." }, { text: "Now the greeting says hola." });
  model.queueSide(
    CHECK,
    { text: '{"met": false, "reason": "The greeting still says hello."}' },
    { text: '{"met": true, "reason": "The greeting says hola."}' },
  );
  const box = page.getByRole("textbox", { name: /^(Type your coding request…|Type \/ for commands)$/ });
  await box.fill("/goal the greeting says hola");
  await box.press("Enter");

  const card = page.getByRole("group", { name: "Goal" });
  await expect(card.getByText("the greeting says hola")).toBeVisible();
  await expect(page.getByText("Goal not met yet: The greeting still says hello.")).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("Achieved in 2 turns");
  await expect(page.getByText("Goal met in 2 turns")).toBeVisible();

  // The second turn was the goal's own, with what the check found.
  expect(model.requests).toHaveLength(2);
  expect(JSON.stringify(model.requests[1].messages)).toContain("<goal-check>The goal isn't met yet: The greeting still says hello.");

  await card.getByRole("button", { name: "Clear goal" }).click();
  await expect(card).toHaveCount(0);
});
