// The WebDriver servers the native tests need: tauri-driver (from cargo), which starts the app,
// and the platform's own driver behind it. On Windows that is msedgedriver for the installed
// WebView2 runtime's exact version, downloaded once into e2e-native/.drivers/. On Linux it is
// WebKitWebDriver from the system (package webkit2gtk-driver).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVERS = path.join(HERE, ".drivers");

function which(cmd) {
  const res = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.split(/\r?\n/)[0].trim() : null;
}

export function tauriDriver() {
  const local = path.join(process.env.CARGO_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cargo"), "bin", process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver");
  const found = existsSync(local) ? local : which("tauri-driver");
  if (!found) throw new Error("tauri-driver is missing: run `cargo install tauri-driver --locked`.");
  return found;
}

/** The installed WebView2 runtime's version, from the registry. */
function webview2Version() {
  const key = ["HKLM", "SOFTWARE", "WOW6432Node", "Microsoft", "EdgeUpdate", "Clients", "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"].join("\\");
  const out = execFileSync("reg", ["query", key, "/v", "pv"], { encoding: "utf8" });
  const m = /pv\s+REG_SZ\s+(\S+)/.exec(out);
  if (!m) throw new Error("Couldn't find the WebView2 runtime version in the registry.");
  return m[1];
}

/** The native driver behind tauri-driver; null on Linux, where tauri-driver finds WebKitWebDriver itself. */
export async function nativeDriver() {
  if (process.platform !== "win32") return null;
  const version = webview2Version();
  const dir = path.join(DRIVERS, version);
  const exe = path.join(dir, "msedgedriver.exe");
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download msedgedriver ${version} (${res.status} from ${url}).`);
  const zip = path.join(dir, "edgedriver.zip");
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]);
  if (!existsSync(exe)) throw new Error(`msedgedriver.exe wasn't in ${url}.`);
  return exe;
}
