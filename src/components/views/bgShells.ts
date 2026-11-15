import { useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";
import { listen } from "@tauri-apps/api/event";
import type { Translations } from "@/lib/i18n";

export interface BgShell {
  id: string;
  command: string;
  description: string;
  /** The folder it runs in; shells started before Nyxs reported it have none. */
  cwd?: string | null;
  output: string;
  status: string;
  code: number | null;
  startedAt?: number;
  endedAt?: number | null;
}

export function formatTaskDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}min ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}min`;
}

/** Whether a shell runs in this project's folder or one under it. A shell with no folder
 *  (or a browser with no project) can't be told apart, so it counts as the project's. */
export function inWorkspace(s: Pick<BgShell, "cwd">, workspace: string | null | undefined): boolean {
  if (!s.cwd || !workspace) return true;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const dir = norm(s.cwd);
  const root = norm(workspace);
  return dir === root || dir.startsWith(`${root}/`);
}

/** The last line a shell printed that says something, without terminal colors, cut to what
 *  fits on one line. Builds redraw their progress with `\r`, so only its last state counts. */
export function lastOutputLine(text: string, max = 160): string {
  const lines = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .split("\n")
    .map((l) => (l.split("\r").filter((part) => part.trim()).pop() ?? "").trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

export function shellTitle(s: BgShell): string {
  return s.description?.trim() || s.command || s.id;
}

interface BgOutputEvent { id: string; stream: string; line: string }
interface BgExitEvent { id: string; status: string; code: number | null; endedAt?: number }

export const killShell = (id: string) => { invoke("agent_bg_kill", { id }).catch(() => {}); };

/** A shell only known by an event: what `agent_bg_list` says about it is filled in later. */
const unknownShell = (id: string): BgShell => ({ id, command: id, description: "", output: "", status: "running", code: null, startedAt: Date.now() });

/** The shells after a line of output. Without `withOutput` a known shell's output isn't kept,
 *  and the same state comes back so React skips the render. */
export function applyShellOutput(prev: Record<string, BgShell>, { id, line }: BgOutputEvent, withOutput: boolean): Record<string, BgShell> {
  const cur = prev[id];
  if (cur && !withOutput) return prev;
  const base = cur ?? unknownShell(id);
  return { ...prev, [id]: { ...base, output: (base.output + line + "\n").slice(-20_000) } };
}

/** The shells after one exits. A shell that ended before writing anything (or before the list
 *  was read) is new here too: dropping its exit would leave it unseen, or seen as still running
 *  once its metadata arrived. */
export function applyShellExit(prev: Record<string, BgShell>, { id, status, code, endedAt }: BgExitEvent): Record<string, BgShell> {
  const base = prev[id] ?? unknownShell(id);
  return { ...prev, [id]: { ...base, status, code, endedAt: endedAt ?? Date.now() } };
}

/** The app's background shells; with `workspace`, only that project's. `withOutput: false` keeps
 *  their output out: every browser tab follows which servers run, and re-rendering each one on
 *  every batch of a build's output (many a second) slowed the whole app down. */
export function useBgShells(workspace?: string | null, { withOutput = true }: { withOutput?: boolean } = {}) {
  const [shells, setShells] = useState<Record<string, BgShell>>({});

  const fillMeta = (id: string) => {
    invoke<BgShell[]>("agent_bg_list")
      .then((list) => {
        const found = list.find((s) => s.id === id);
        if (found)
          setShells((prev) =>
            prev[id]
              ? { ...prev, [id]: { ...prev[id], command: found.command, description: found.description, cwd: found.cwd, startedAt: found.startedAt } }
              : prev,
          );
      })
      .catch(() => {});
  };

  useEffect(() => {
    let alive = true;
    invoke<BgShell[]>("agent_bg_list")
      .then((list) => { if (alive) setShells(Object.fromEntries(list.map((s) => [s.id, s]))); })
      .catch(() => {});

    const u1 = listen<BgOutputEvent>("bg-shell-output", (e) => {
      setShells((prev) => {
        if (!prev[e.payload.id]) fillMeta(e.payload.id);
        return applyShellOutput(prev, e.payload, withOutput);
      });
    });
    const u2 = listen<BgExitEvent>("bg-shell-exit", (e) => {
      setShells((prev) => {
        if (!prev[e.payload.id]) fillMeta(e.payload.id);
        return applyShellExit(prev, e.payload);
      });
    });

    return () => {
      alive = false;
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [withOutput]);

  const list = Object.values(shells)
    .filter((s) => workspace === undefined || inWorkspace(s, workspace))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { list, setShells };
}

export function shellStatus(s: BgShell, t: Translations["views"]): { running: boolean; dot: string; label: string } {
  if (s.status === "running") return { running: true, dot: "bg-accent", label: t.running };
  if (s.status === "killed") return { running: false, dot: "bg-text-500", label: t.stopped };
  if ((s.code ?? 0) === 0) return { running: false, dot: "bg-green-400", label: t.completed };
  return { running: false, dot: "bg-red-400", label: t.errorCode.replace("{code}", String(s.code ?? "?")) };
}
