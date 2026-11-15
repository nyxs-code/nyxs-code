import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@/lib/ipc";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** At most this many interface errors a minute go to the log: a render loop that throws on
 *  every frame would otherwise fill it with the same line. */
const MAX_PER_MINUTE = 30;
let windowStart = 0;
let sent = 0;

function send(level: "error" | "warn", message: string): void {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    sent = 0;
  }
  if (++sent > MAX_PER_MINUTE) return;
  void invoke("nyxs_log_frontend", { level, message }).catch(() => undefined);
}

const describe = (e: unknown) =>
  e instanceof Error ? `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ""}` : typeof e === "string" ? e : JSON.stringify(e);

/** Uncaught errors and failed promises of the interface go to Nyxs' log, so a saved zip has
 *  them next to the backend's. */
export function installFrontendLogging(): void {
  if (!isTauri) return;
  window.addEventListener("error", (e) => send("error", `${describe(e.error ?? e.message)} (${e.filename}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => send("error", `Unhandled rejection: ${describe(e.reason)}`));
}

/** Asks where to save, then zips the logs there. Null when the user cancelled. */
export async function saveLogsZip(): Promise<{ path: string; files: number } | null> {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  const path = await save({ defaultPath: `nyxs-logs-${stamp}.zip`, filters: [{ name: "Zip", extensions: ["zip"] }] });
  if (!path) return null;
  const files = await invoke<number>("nyxs_export_logs", { dest: path });
  return { path, files };
}
