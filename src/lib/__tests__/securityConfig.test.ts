import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const capability = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/capabilities/default.json"), "utf8"));

type CspMap = Record<string, string[]>;
const csp: CspMap = conf.app.security.csp;
const devCsp: CspMap = conf.app.security.devCsp;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

describe("Tauri security configuration", () => {
  it("ships a real CSP and a dev CSP that only relaxes what Vite needs", () => {
    expect(csp).toBeTypeOf("object");
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(Object.keys(devCsp).sort()).toEqual(Object.keys(csp).sort());
    for (const [directive, sources] of Object.entries(devCsp)) {
      const extra = sources.filter((s) => !csp[directive].includes(s));
      const allowed = directive === "script-src" ? ["'unsafe-inline'"] : directive === "connect-src" ? ["ws://localhost:1420", "ws://127.0.0.1:1420"] : [];
      expect(extra.every((s) => allowed.includes(s)), `${directive}: ${extra.join(" ")}`).toBe(true);
      expect(csp[directive].every((s) => sources.includes(s)), directive).toBe(true);
    }
    expect(Object.values(devCsp).flat()).not.toContain("'unsafe-eval'");
  });

  it("does not let the asset protocol or the http plugin reach everything", () => {
    expect(conf.app.security.assetProtocol.scope).not.toContain("**");
    const http = capability.permissions.find((p: { identifier?: string }) => p.identifier === "http:default");
    const urls: string[] = http.allow.map((e: { url: string }) => e.url);
    expect(urls).not.toEqual(expect.arrayContaining(["http://**", "http://*:*/*", "http://**/*"]));
    expect(urls.filter((u) => u.startsWith("http://*")).every((u) => /^http:\/\/\*\.(local|localhost):/.test(u))).toBe(true);
  });

  it("never renders previews in a same-origin srcdoc iframe, which would inherit the app's origin and CSP", () => {
    const offenders = walk(path.join(root, "src")).filter((f) => /srcDoc\s*=/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
