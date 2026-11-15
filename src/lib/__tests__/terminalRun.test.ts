import { describe, it, expect } from "vitest";
import { tokenizeShell } from "@/lib/highlight";
import { terminalRunOutput } from "@/lib/terminalRun";

/** Token texts grouped by their color role, read off the class name. */
function roles(code: string): [string, string][] {
  return tokenizeShell(code)
    .filter((t) => t.text.trim())
    .map((t) => [t.text, t.cls.includes("violet") ? "cmd" : t.cls.includes("cyan") ? "flag" : t.cls.includes("emerald") ? "str" : t.cls.includes("amber") ? "var" : t.cls.includes("text-text-400") ? "comment" : t.cls.includes("text-text-300") ? "op" : "arg"]);
}

describe("tokenizeShell", () => {
  it("colors the program apart from its arguments", () => {
    expect(roles("npm run dev")).toEqual([["npm", "cmd"], ["run", "arg"], ["dev", "arg"]]);
  });

  it("starts a new command after pipes and &&, and colors flags, strings and comments", () => {
    expect(roles(`git log --oneline | grep "fix" && echo ok  # done`)).toEqual([
      ["git", "cmd"], ["log", "arg"], ["--oneline", "flag"], ["|", "op"], ["grep", "cmd"], ['"fix"', "str"],
      ["&&", "op"], ["echo", "cmd"], ["ok", "arg"], ["# done", "comment"],
    ]);
  });

  it("handles env assignments, variables and a pasted prompt", () => {
    expect(roles("$ NODE_ENV=test npx vitest $HOME")).toEqual([
      ["$", "comment"], ["NODE_ENV=test", "var"], ["npx", "cmd"], ["vitest", "arg"], ["$HOME", "var"],
    ]);
    expect(roles("$env:DEBUG = 1")).toEqual([["$env:DEBUG", "var"], ["=", "arg"], ["1", "arg"]]);
  });

  it("restarts the command on every line and keeps a # inside a word", () => {
    expect(roles("npm i\ncurl http://x.dev/#top")).toEqual([["npm", "cmd"], ["i", "arg"], ["curl", "cmd"], ["http://x.dev/#top", "arg"]]);
  });

  it("gives the text back unchanged", () => {
    const code = `cd "a b" && ls -la > out.txt 2>&1; echo $(pwd)\n  # note`;
    expect(tokenizeShell(code).map((t) => t.text).join("")).toBe(code);
  });
});

describe("terminalRunOutput", () => {
  // A fresh shell: startup escapes and a blank line, then the prompt with the colored echo.
  const raw =
    "\x1b[?25l\x1b[2J\x1b[H\r\n" +
    "PS D:\\optimicer> \x1b[93mnpm\x1b[0m test\r\n\r\n> vitest run\r\n\r\n ✓ a.test.ts (3)\r\n\r\nPS D:\\optimicer> ";

  it("starts after the line that echoed the command", () => {
    expect(terminalRunOutput(raw, "npm test", false)).toBe("\n> vitest run\n\n ✓ a.test.ts (3)\n\nPS D:\\optimicer> ");
  });

  it("also drops the fresh prompt once done", () => {
    expect(terminalRunOutput(raw, "npm test", true)).toBe("\n> vitest run\n\n ✓ a.test.ts (3)");
  });

  it("shows nothing while the echo line is still being written", () => {
    expect(terminalRunOutput("PS D:\\x> npm te", "npm test", false)).toBe("");
    expect(terminalRunOutput("PS D:\\x> npm test", "npm test", false)).toBe("");
  });
});
