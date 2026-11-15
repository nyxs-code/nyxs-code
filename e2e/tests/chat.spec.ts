import { test, expect, sendPrompt, backendCalls, savedTranscript } from "../fixtures";

test("a prompt gets the model's streamed answer and is saved as a session", async ({ page, app, model }) => {
  await app();
  model.queue({ text: "Hola desde el modelo falso, en varios trozos." });

  await sendPrompt(page, "Di hola");

  await expect(page.getByText("Hola desde el modelo falso, en varios trozos.")).toBeVisible();
  await expect(page.getByText("Di hola", { exact: true })).toBeVisible();
  // The prompt reached the model.
  const userText = model.requests[0].messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
  expect(userText.join(" ")).toContain("Di hola");
  // The session shows in the sidebar with its generated title and is written to disk.
  await expect(page.getByRole("button", { name: /^Sesión de prueba/ })).toBeVisible();
  await expect.poll(() => savedTranscript(page)).toContain("Hola desde el modelo falso, en varios trozos.");
  expect(await savedTranscript(page)).toContain("Di hola");
  expect((await backendCalls(page, "nyxs_session_write_meta")).length).toBeGreaterThan(0);
});
