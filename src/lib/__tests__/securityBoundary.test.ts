import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// The app's real security boundary is that no foreign code runs in its own webview: any script
// there can call Rust, run shell commands included. Its CSP keeps scripts to the app's bundle
// (tested in src-tauri/src/security_config.rs); these checks keep the HTML it shows from
// others (the agent's visuals and mockups, pages, markdown) out of it too.

const SRC = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(e.name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }));

/** Each `<iframe …>` element in the source, up to its closing `>` or `/>`. */
function iframes(text: string): string[] {
  return [...text.matchAll(/<iframe\b[\s\S]*?\/?>/g)].map((m) => m[0]);
}

/** Files whose iframe sandbox keeps the page's own origin on purpose, and why that is safe. */
const SAME_ORIGIN: Record<string, string> = {
  // The local page preview: a page of the user's project on the preview host
  // (nyxspreview.localhost:<port>), which isn't the app's origin, so its own origin can't reach
  // the app's window; pages need it for storage, cookies and module scripts.
  "components/views/preview/PreviewPage.tsx": "local page preview",
};

describe("security boundary", () => {
  it("sandboxes every iframe that shows foreign HTML, without allow-same-origin", () => {
    const found = files.flatMap(({ path, text }) => iframes(text).map((tag) => ({ path, tag })));
    expect(found.length).toBeGreaterThan(0);
    for (const { path, tag } of found) {
      expect(tag, `${path}: iframe without sandbox`).toMatch(/\bsandbox=/);
      if (SAME_ORIGIN[path]) continue;
      expect(tag, `${path}: iframe must not get allow-same-origin`).not.toMatch(/allow-same-origin/);
    }
  });

  it("never lets a framed page navigate the app's window", () => {
    for (const { path, text } of files) {
      expect(text, `${path}: a sandbox must not allow top navigation`).not.toMatch(/allow-top-navigation/);
    }
  });

  it("keeps the page's own origin only where it is listed", () => {
    for (const path of Object.keys(SAME_ORIGIN)) {
      const file = files.find((f) => f.path === path);
      expect(file, `${path} no longer exists: drop it from SAME_ORIGIN`).toBeTruthy();
      expect(iframes(file!.text).length, `${path}: expected one preview iframe`).toBe(1);
    }
    const others = files.filter(({ path, text }) => !SAME_ORIGIN[path] && /["'`\s]allow-same-origin\b/.test(text)).map((f) => f.path);
    expect(others).toEqual([]);
  });

  it("never writes raw HTML into the app's own page", () => {
    const offenders = files
      .filter(({ text }) => /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\(/.test(text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("doesn't evaluate strings as code", () => {
    const offenders = files.filter(({ text }) => /\beval\(|new Function\(/.test(text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
