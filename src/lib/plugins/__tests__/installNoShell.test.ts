import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeBackend } from "./fakeBackend";

const state = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };
  return { backend: null as FakeBackend | null };
});

vi.mock("@/lib/ipc", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => state.backend!.handle(cmd, args),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => state.backend!.home }));
vi.mock("@/lib/preflight", () => ({ clearPreflightCache: () => {} }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
vi.mock("@/lib/plugins/pluginSettings", () => ({
  getEnabledPlugins: async () => [],
  setPluginEnabled: async () => {},
}));
const marketplaces = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/plugins/marketplace", () => ({
  getMarketplace: async (name: string) => marketplaces.get(name) ?? null,
}));

import { createFakeBackend, fileUrl, makeRepo, makeTempDir } from "./fakeBackend";
import {
  isSafeGitUrl,
  isSafeNpmPackage,
  isSafeRef,
  isSafeSlug,
  safeRelativePath,
} from "../sourceSafety";
import { installSkillFromGithub } from "@/lib/skillsInstall";
import { listSkillsInGithubRepo } from "@/lib/skillsSh";
import { clearCatalogMemo, ensureGitCheckout } from "../catalog";
import { installPlugin } from "../install";

const INJECTIONS = ["a$(touch pwned)", "a`id`", 'a"; rm -rf ~; "', "a'; calc; '", "a && calc", "..", "-oops"];

describe("catalog values are checked before they reach git or a folder name", () => {
  it("accepts what real catalogs use", () => {
    expect(isSafeRef("v1.5.5")).toBe(true);
    expect(isSafeRef("feature/new-ui")).toBe(true);
    expect(safeRelativePath("./plugins/agent-sdk-dev")).toBe("plugins/agent-sdk-dev");
    expect(safeRelativePath("plugins/creative-cloud/adobe-for-creativity")).toBe(
      "plugins/creative-cloud/adobe-for-creativity",
    );
    expect(safeRelativePath("./")).toBe("");
    expect(isSafeSlug("frontend-design")).toBe(true);
    expect(isSafeGitUrl("https://github.com/42Crunch-AI/claude-plugins.git")).toBe(true);
    expect(isSafeGitUrl("git@github.com:owner/repo.git")).toBe(true);
    expect(isSafeGitUrl("file:///C:/repos/mp")).toBe(true);
    expect(isSafeNpmPackage("@scope/pkg@1.2.3")).toBe(true);
  });

  it("refuses shell syntax, option-like values and paths that climb out", () => {
    for (const bad of INJECTIONS) {
      expect(isSafeSlug(bad), bad).toBe(false);
      expect(isSafeRef(bad), bad).toBe(false);
    }
    expect(isSafeRef("--upload-pack=calc")).toBe(false);
    expect(safeRelativePath("../../.ssh")).toBeNull();
    expect(safeRelativePath("plugins/../../x")).toBeNull();
    expect(safeRelativePath("/etc")).toBeNull();
    expect(safeRelativePath("plugins/$(calc)")).toBeNull();
    expect(isSafeGitUrl("ext::sh -c touch% /tmp/pwned")).toBe(false);
    expect(isSafeGitUrl("--upload-pack=calc")).toBe(false);
    expect(isSafeGitUrl("ssh://-oProxyCommand=calc/x")).toBe(false);
    expect(isSafeGitUrl('https://x/"; calc; "')).toBe(false);
    expect(isSafeNpmPackage("pkg; calc")).toBe(false);
    expect(isSafeNpmPackage("pkg$(calc)")).toBe(false);
  });
});

describe("installing skills and plugins never goes through the shell", () => {
  let backend: FakeBackend;
  let remotes: string;

  beforeAll(() => {
    backend = createFakeBackend();
    state.backend = backend;
    (window as unknown as Record<string, unknown>).__NYXS_HOME__ = backend.home;
    remotes = makeTempDir("remotes");
  });
  afterAll(() => {
    backend.cleanup();
    fs.rmSync(remotes, { recursive: true, force: true });
  });
  beforeEach(() => {
    backend.calls.length = 0;
    clearCatalogMemo();
  });

  it("refuses a skill whose folder name carries shell syntax, before running anything", async () => {
    for (const slug of INJECTIONS) {
      await expect(installSkillFromGithub("anthropics/skills", slug)).rejects.toThrow(/unsafe skill name/);
    }
    await expect(installSkillFromGithub("a/b; calc", "ok")).rejects.toThrow(/unsafe skill source/);
    expect(backend.calls).toEqual([]);
  });

  it("drops such folders from a repo's skill listing", async () => {
    const tree = ["skills/review/SKILL.md", "skills/a$(touch pwned)/SKILL.md", "skills/a`id`/SKILL.md"];
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("api.github.com")
        ? new Response(JSON.stringify({ tree: tree.map((p) => ({ path: p, type: "blob" })) }))
        : new Response("---\nname: review\n---\n"),
    );
    vi.stubGlobal("fetch", fetchMock);
    backend.fetch = () => "---\nname: review\n---\n";
    try {
      const skills = await listSkillsInGithubRepo("owner/repo");
      expect(skills.map((s) => s.slug)).toEqual(["review"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("installs a skill with git arguments and the backend copy", async () => {
    const repo = `${remotes}/skills-repo`;
    makeRepo(repo, [{ "skills/review/SKILL.md": "---\nname: review\n---\nbody", "README.md": "x" }]);
    backend.serveGithub("owner/skills-repo", repo);

    const dest = await installSkillFromGithub("owner/skills-repo", "review");

    expect(dest).toBe(`${backend.home}/.nyxs/skills/review`);
    expect(fs.readFileSync(`${dest}/SKILL.md`, "utf8")).toContain("name: review");
    expect(backend.calls.some((c) => c.cmd === "agent_run")).toBe(false);
    const clone = backend.calls.find((c) => c.cmd === "agent_git" && (c.args.args as string[]).includes("clone"));
    expect(clone?.args.args).toEqual(expect.arrayContaining(["--", "https://github.com/owner/skills-repo.git"]));
    expect(backend.calls.some((c) => c.cmd === "nyxs_copy_managed_dir")).toBe(true);
  });

  it("refuses unsafe git URLs and refs from a catalog", async () => {
    await expect(ensureGitCheckout(`${remotes}/x`, "ext::sh -c calc")).rejects.toThrow(/unsafe git URL/);
    await expect(ensureGitCheckout(`${remotes}/x`, "https://h/r.git", { ref: "$(calc)" })).rejects.toThrow(
      /unsafe git ref/,
    );
    await expect(ensureGitCheckout(`${remotes}/x`, "https://h/r.git", { sha: "HEAD; calc" })).rejects.toThrow(
      /unsafe commit sha/,
    );
    expect(backend.calls).toEqual([]);
  });

  it("refuses a plugin path that climbs out of its checkout", async () => {
    const repo = `${remotes}/plugin-repo`;
    makeRepo(repo, [{ "plugins/p/plugin.json": "{}" }]);
    marketplaces.set("mp", {
      name: "mp",
      source: { source: "url", url: "https://example.invalid/marketplace.json" },
      installLocation: `${backend.home}/.nyxs/plugins/marketplaces/mp`,
      autoUpdate: false,
    });
    backend.fetch = () =>
      JSON.stringify({
        plugins: [
          { name: "escape", source: { source: "url", url: fileUrl(repo), path: "../../../.ssh" } },
          { name: "local", source: { source: "directory", path: "C:/Users/me/.ssh" } },
        ],
      });

    await expect(installPlugin("mp", "escape")).rejects.toThrow(/unsafe path for plugin "escape"/);
    await expect(installPlugin("mp", "local")).rejects.toThrow(/only a local marketplace/);
    expect(backend.calls.some((c) => c.cmd === "nyxs_copy_managed_dir" || c.cmd === "agent_run")).toBe(false);
  });
});
