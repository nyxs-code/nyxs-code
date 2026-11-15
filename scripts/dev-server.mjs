// `beforeDevCommand` of `tauri dev`: starts Vite on 1420, or reuses the one an earlier
// `tauri dev` left running there. Vite runs with `strictPort`, so a second one used to fail with
// "Port 1420 is already in use" even though the app had already loaded the old one. Anything
// else on 1420 stops here with a clear message instead.
//
// The E2E suite runs its own Vite on 1431 (e2e/vite.config.ts) and doesn't go through here.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = 1420;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** A file Vite serves as is from `public/`: another server on the port can't answer with these bytes. */
const PROBE = "icons.svg";
/** While reusing, how often to check the old Vite is still there. */
const WATCH_MS = 2000;

/** What answers on the port: "free", "ours" (this repo's Vite) or "other". */
export async function probe(port = PORT, root = ROOT) {
  let res;
  try {
    res = await fetch(`http://localhost:${port}/${PROBE}`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return "free";
  }
  if (!res.ok) return "other";
  const served = Buffer.from(await res.arrayBuffer());
  const local = readFileSync(path.join(root, "public", PROBE));
  return served.equals(local) ? "ours" : "other";
}

function startVite() {
  const vite = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => vite.kill(signal));
  vite.on("exit", (code) => process.exit(code ?? 0));
}

/** Stays up while the old Vite does: tauri dev treats this command ending as the dev server
 *  going away. */
function watchReused() {
  console.log(`[dev] Reusing the Vite already serving this project on http://localhost:${PORT}.`);
  const timer = setInterval(async () => {
    if ((await probe()) === "ours") return;
    clearInterval(timer);
    console.error(`[dev] The Vite on port ${PORT} stopped. Run \`npm run tauri dev\` again to start a new one.`);
    process.exit(1);
  }, WATCH_MS);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
}

async function main() {
  const state = await probe();
  if (state === "free") return startVite();
  if (state === "ours") return watchReused();
  console.error(
    `[dev] Port ${PORT} is in use by something that isn't this project's Vite. ` +
      `Close it (or the other dev server using it) and run \`npm run tauri dev\` again.`,
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
