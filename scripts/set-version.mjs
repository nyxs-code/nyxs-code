// Sets the app version everywhere the repo keeps it, so a checkout says which release it is:
//   node scripts/set-version.mjs 0.8.25
// package.json, package-lock.json, src-tauri/tauri.conf.json (the version the app and the
// updater report), src-tauri/Cargo.toml and the app's entry in src-tauri/Cargo.lock.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <x.y.z>");
  process.exit(1);
}

/** Rewrites a file keeping its line endings. */
function edit(path, change) {
  const text = readFileSync(path, "utf8");
  const crlf = text.includes("\r\n");
  const next = change(text.replace(/\r\n/g, "\n"));
  if (next === null) throw new Error(`${path}: version field not found`);
  writeFileSync(path, crlf ? next.replace(/\n/g, "\r\n") : next);
}

/** Replaces the first match of `re` (whose group 1 is the version) and fails if there is none. */
const replaceFirst = (re) => (text) => (re.test(text) ? text.replace(re, (m, old) => m.replace(old, version)) : null);

edit("package.json", replaceFirst(/^ {2}"version": "([^"]+)"/m));
// The root package appears twice in the lockfile: at the top and as packages[""].
edit("package-lock.json", (text) => {
  const top = replaceFirst(/^ {2}"version": "([^"]+)"/m)(text);
  return top && replaceFirst(/"packages": \{\n {4}"": \{\n {6}"name": "[^"]+",\n {6}"version": "([^"]+)"/)(top);
});
edit("src-tauri/tauri.conf.json", replaceFirst(/^ {2}"version": "([^"]+)"/m));
edit("src-tauri/Cargo.toml", replaceFirst(/^\[package\]\nname = "app"\nversion = "([^"]+)"/m));
edit("src-tauri/Cargo.lock", replaceFirst(/^\[\[package\]\]\nname = "app"\nversion = "([^"]+)"/m));

console.log(`Version set to ${version}`);
