import { LocalizedError } from "@/lib/localizedError";

// Values here come from downloaded catalogs and repo listings. They end up as git arguments
// and folder names, so they are checked against what real catalogs use before anything runs.

const REF_RE = /^[\w./-]+$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const SLUG_RE = /^\w[\w.-]*$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const NPM_RE = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*(@[\w.^~*+-]+)?$/i;

/** A branch or tag name: no `..`, no leading `-` (git would read it as an option). */
export function isSafeRef(ref: string): boolean {
  return (
    REF_RE.test(ref) &&
    !ref.startsWith("-") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.includes("..") &&
    !ref.endsWith(".lock")
  );
}

export function isSafeSha(sha: string): boolean {
  return SHA_RE.test(sha);
}

/** One folder name, such as a skill slug. */
export function isSafeSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && slug !== "." && slug !== "..";
}

/** `owner/repo` on GitHub. */
export function isSafeRepo(repo: string): boolean {
  return REPO_RE.test(repo) && repo.split("/").every((s) => s !== "." && s !== "..");
}

export function isSafeNpmPackage(pkg: string): boolean {
  return NPM_RE.test(pkg);
}

/**
 * A path inside a checkout (`./plugins/foo`), normalized without the leading `./`, or `null`
 * when it is absolute, climbs out with `..`, or uses characters catalogs never do.
 */
export function safeRelativePath(path: string): string | null {
  const trimmed = path.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  if (!REF_RE.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("-")) return null;
  const parts = trimmed.split("/");
  if (parts.some((p) => p === ".." || p === "")) return null;
  return parts.filter((p) => p !== ".").join("/");
}

/**
 * A URL git may clone: http(s), ssh, git or file URLs, `user@host:path`, or a local absolute
 * path. Transport-helper syntax (`ext::sh -c …`), option-like values and whitespace are refused.
 */
export function isSafeGitUrl(url: string): boolean {
  if (!url || url !== url.trim() || /[\s\0]/.test(url) || url.startsWith("-")) return false;
  // A host starting with `-` would reach ssh as an option.
  if (/^(https?|ssh|git):\/\/[^/-]/i.test(url)) return true;
  if (/^file:\/\//i.test(url)) return true;
  if (url.includes("::")) return false;
  if (/^[\w.-]+@[\w.][\w.-]*:[\w./~-]+$/.test(url)) return true;
  return /^([A-Za-z]:[\\/]|\/)/.test(url);
}

/** Which value was refused, with how its English message names it. */
const UNSAFE = {
  gitUrl: { key: "unsafeGitUrl", what: () => "git URL" },
  gitRef: { key: "unsafeGitRef", what: () => "git ref" },
  sha: { key: "unsafeSha", what: () => "commit sha" },
  repo: { key: "unsafeRepo", what: () => "GitHub repo" },
  npmPackage: { key: "unsafeNpmPackage", what: () => "npm package" },
  skillName: { key: "unsafeSkillName", what: () => "skill name" },
  skillSource: { key: "unsafeSkillSource", what: () => "skill source" },
  pluginPath: { key: "unsafePluginPath", what: (plugin: string) => `path for plugin "${plugin}"` },
} as const;

export type UnsafeKind = keyof typeof UNSAFE;

/** Throws a short error naming the value when `ok` is false (shown translated in the UI). */
export function requireSafe(ok: boolean, kind: UnsafeKind, value: string, plugin = ""): void {
  if (ok) return;
  const { key, what } = UNSAFE[kind];
  const shown = JSON.stringify(value);
  throw new LocalizedError(key, { value: shown, plugin }, `Refusing unsafe ${what(plugin)}: ${shown}.`);
}
