// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyEnvironment,
  deleteEnvironment,
  envForSession,
  environmentVariablesText,
  parseEnvText,
  pendingEnvironment,
  registerSessionEnvironment,
  saveEnvironment,
  savedEnvironments,
} from "@/lib/environments";
import { sessionWorktreeOn } from "@/lib/sessionWorktree";

describe("saved environments", () => {
  it("reads KEY=value lines, skipping blanks and comments, and reports bad lines", () => {
    expect(parseEnvText("API_URL=http://x\n\n# note\nexport TOKEN=\"a b\"\nNAME='q'\nbad line\n1X=2")).toEqual({
      vars: { API_URL: "http://x", TOKEN: "a b", NAME: "q" },
      bad: [6, 7],
    });
  });

  it("keeps the variables apart from the list, and gives them only to sessions started there", async () => {
    const env = await saveEnvironment({ name: "API", folder: "D:\\api", worktree: true }, "PORT=4000\nMODE=dev");
    expect(savedEnvironments()).toEqual([{ id: env.id, name: "API", folder: "D:\\api", worktree: true }]);
    expect(JSON.stringify(savedEnvironments())).not.toContain("PORT");
    expect(await environmentVariablesText(env.id)).toBe("PORT=4000\nMODE=dev");

    registerSessionEnvironment("chat-a", env.id);
    expect(await envForSession("chat-a")).toEqual({ PORT: "4000", MODE: "dev" });
    expect(await envForSession("chat-b")).toBeUndefined();

    let opened = "";
    applyEnvironment(env, (p) => { opened = p; });
    expect(opened).toBe("D:\\api");
    expect(sessionWorktreeOn()).toBe(true);
    expect(pendingEnvironment()).toBe(env.id);

    await deleteEnvironment(env.id);
    expect(savedEnvironments()).toEqual([]);
    expect(pendingEnvironment()).toBeNull();
    expect(await environmentVariablesText(env.id)).toBe("");
  });
});
