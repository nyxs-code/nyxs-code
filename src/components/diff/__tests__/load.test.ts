import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real git in a temporary repo; only the bridge to Rust is replaced.
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@/lib/gitErrors", () => ({
  runGit: async (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1, timed_out: false };
  },
}));

const { loadChanges } = await import("../load");

let repo = "";
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "nyxs-diff-"));
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "core.autocrlf", "false");
  // Git's default, set here so a machine that turned it off doesn't hide the bug.
  git("config", "core.quotepath", "true");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "guía.md"), "uno\n");
  writeFileSync(join(repo, "plain.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "docs", "guía.md"), "uno\ndos\n");
  writeFileSync(join(repo, "plain.txt"), "a\nb\n");
  mkdirSync(join(repo, "notas"));
  writeFileSync(join(repo, "notas", "año.txt"), "hola\n");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("loadChanges", () => {
  it("shows the diff of files with accents and ñ in their path", async () => {
    const files = await loadChanges(repo, false, "HEAD");
    const byPath = new Map(files.map((f) => [f.path, f]));
    const guide = byPath.get("docs/guía.md");
    expect(guide, [...byPath.keys()].join(", ")).toBeTruthy();
    expect(guide!.missing).toBe(false);
    expect(guide!.added).toBe(1);
    expect(guide!.hunks.flatMap((h) => h.rows).filter((r) => r.type === "add").map((r) => r.text)).toEqual(["dos"]);
    expect(byPath.get("plain.txt")?.hunks).toHaveLength(1);
    const added = byPath.get("notas/año.txt");
    expect(added?.added).toBe(1);
    expect(added?.missing).toBe(false);
  });
});
