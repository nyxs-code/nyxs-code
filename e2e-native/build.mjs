// Builds the app the native end-to-end tests drive (see e2e-native/README.md):
// - the frontend into dist-e2e/, with the backend pointed at the tests' local scripted server;
// - a debug app.exe with its own identifier (so its app data never mixes with the installed
//   Nyxs) and no installer, in its own target dir so it never fights a running `tauri dev`
//   over target/debug/app.exe.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_PORT = Number(process.env.NYXS_E2E_NATIVE_PORT ?? 47731);
export const TARGET_DIR = path.join(ROOT, "src-tauri", "target-e2e");
export const APP_EXE = path.join(TARGET_DIR, "debug", process.platform === "win32" ? "app.exe" : "app");
export const IDENTIFIER = "com.nyxs.desktop.e2e";

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.status})`);
}

export function build() {
  run("npx", ["vite", "build", "--outDir", "dist-e2e", "--emptyOutDir"], { VITE_NYXS_API_BASE: `http://127.0.0.1:${SERVER_PORT}` });
  // The main window as the app's, but hidden, not maximized and without taking focus, so a run
  // never covers the user's work: the app moves it off every monitor and only then shows it
  // (`test_data_dir::move_window_off_screen`), since tao ignores an off-screen x/y here. The
  // --config merge replaces arrays whole, so every window is copied.
  const appConfig = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  const windows = appConfig.app.windows.map((w, i) =>
    i === 0 ? { ...w, maximized: false, focus: false, visible: false } : w,
  );
  const config = {
    identifier: IDENTIFIER,
    // Relative to src-tauri/, like tauri.conf.json's: an absolute Windows path is taken for a
    // URL and the window loads it as a folder listing instead of embedding the files.
    build: { beforeBuildCommand: "", frontendDist: "../dist-e2e" },
    bundle: { active: false },
    app: { windows },
  };
  // A file rather than inline JSON: npx goes through cmd.exe on Windows, which mangles quotes.
  mkdirSync(TARGET_DIR, { recursive: true });
  const configFile = path.join(TARGET_DIR, "tauri.e2e.conf.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  run("npx", ["tauri", "build", "--debug", "--no-bundle", "--config", configFile], { CARGO_TARGET_DIR: TARGET_DIR });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
