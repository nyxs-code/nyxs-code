import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import { listen } from "@tauri-apps/api/event";
import { Check, Copy, Play, Square, Terminal } from "lucide-react";
import { ansiRuns, type AnsiColor } from "@/lib/ansi";
import { tokenizeShell } from "@/lib/highlight";
import { useTranslations } from "@/lib/i18n";
import { showInTerminal, terminalRunOutput } from "@/lib/terminalRun";
import { cn } from "@/lib/utils";
import { defaultToolPromptEnv } from "@/tools/env";
import { commandRows, useCommandRunEnv, type CommandRow } from "./commandRun";

/** Only the tail of a chatty command is kept on screen; the terminal has the rest. */
const OUTPUT_KEEP = 200_000;
/** How often to ask the shell whether the command is still running. */
const BUSY_POLL_MS = 700;
/** A shell builtin (cd, Get-ChildItem…) never starts a child process, so "never busy" for this
 *  long means it already finished. */
const BUILTIN_GRACE_MS = 2500;
/** Size of the shell a Run starts; the Terminal panel resizes it if the user opens it there. */
const PTY_SIZE = { rows: 30, cols: 120 };

const ANSI_CLASS: Record<AnsiColor, string> = {
  red: "text-danger",
  green: "text-success",
  yellow: "text-warning",
  blue: "text-[color:var(--link)]",
  magenta: "text-fuchsia-600 dark:text-fuchsia-400",
  cyan: "text-cyan-700 dark:text-cyan-400",
  gray: "text-text-400",
};

const ICON_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded-[6px] text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100";

interface Run {
  termId: string;
  command: string;
  raw: string;
  status: "running" | "done" | "error";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function ShellCode({ code }: { code: string }) {
  const tokens = useMemo(() => tokenizeShell(code), [code]);
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} className={t.cls || undefined}>
          {t.text}
        </span>
      ))}
    </>
  );
}

function AnsiOutput({ text }: { text: string }) {
  const runs = useMemo(() => ansiRuns(text), [text]);
  return (
    <>
      {runs.map((r, i) => (
        <span key={i} className={cn(r.color && ANSI_CLASS[r.color], r.bold && "font-semibold", r.dim && "opacity-60")}>
          {r.text}
        </span>
      ))}
    </>
  );
}

/** The run's output as the terminal prints it, attached under the command. Follows the end
 *  unless the user scrolled up to read. */
function RunOutput({ run, onOpen }: { run: Run; onOpen: () => void }) {
  const tx = useTranslations().messageExtra;
  const running = run.status === "running";
  const text = useMemo(
    () => (run.status === "error" ? run.raw : terminalRunOutput(run.raw, run.command, !running)),
    [run.raw, run.command, run.status, running],
  );
  const outRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="relative my-1 rounded-[6px] border border-bg-300 animate-fade-in">
      <pre
        ref={outRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className={cn(
          "max-h-60 overflow-auto custom-scrollbar py-2 pl-3.5 pr-10 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all",
          run.status === "error" ? "text-danger" : "text-text-300",
        )}
      >
        {text ? <AnsiOutput text={text} /> : !running && <span className="text-text-400">{tx.noOutput}</span>}
        {running && !text && <span className="inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-text-400" />}
      </pre>
      {run.termId && (
        // right-[5px] + the 1px border puts it in the same column as Copy in the box above.
        <button type="button" onClick={onOpen} aria-label={tx.openInTerminal} data-tooltip={tx.openInTerminal} className={cn(ICON_BUTTON, "absolute right-[5px] top-1")}>
          <Terminal className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** A shell block from the reply, with Run and Copy next to each command: a list of independent
 *  commands gets them on every line, a script once for the whole block. Run starts the command
 *  in a shell of its own (the Terminal panel stays as it is) and shows what it prints right under
 *  the line; "Open in terminal" hands that shell to the Terminal panel. */
export function RunnableCommand({
  content,
  closed = true,
}: {
  lang: string;
  content: string;
  /** False while the fence is still streaming: no Run on half a command. */
  closed?: boolean;
}) {
  const tx = useTranslations().messageExtra;
  const { workspace, openView } = useCommandRunEnv();
  const rows = useMemo(() => commandRows(content), [content]);
  const [runs, setRuns] = useState<Record<number, Run>>({});
  const [copiedRow, setCopiedRow] = useState<number | null>(null);

  // Shells this block started, and those the user moved to the Terminal panel. Leaving the chat
  // closes the others, so finished runs don't leave idle shells behind.
  const shellsRef = useRef(new Set<string>());
  const adoptedRef = useRef(new Set<string>());
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    const shells = shellsRef.current;
    const adopted = adoptedRef.current;
    return () => {
      aliveRef.current = false;
      for (const id of shells) if (!adopted.has(id)) void invoke("term_close", { id }).catch(() => {});
    };
  }, []);

  const copy = (row: number, command: string) => {
    void navigator.clipboard.writeText(command);
    setCopiedRow(row);
    setTimeout(() => setCopiedRow((r) => (r === row ? null : r)), 1500);
  };

  const update = (row: number, termId: string, fn: (run: Run) => Run) =>
    setRuns((prev) => (prev[row]?.termId === termId ? { ...prev, [row]: fn(prev[row]) } : prev));

  const start = async (row: number, command: string) => {
    const previous = runs[row];
    if (previous?.status === "running") return;
    // Running it again replaces the last run's shell, unless that one now lives in the panel.
    if (previous?.termId && !adoptedRef.current.has(previous.termId)) {
      shellsRef.current.delete(previous.termId);
      void invoke("term_close", { id: previous.termId }).catch(() => {});
    }
    // Listen before the shell exists: it starts printing (its prompt, the echo of the command)
    // before term_open even returns its id.
    const decoder = new TextDecoder();
    const early: { id: string; data: string }[] = [];
    let termId: string | null = null;
    const unlisten = await listen<{ id: string; data: string }>("term-output", (e) => {
      if (termId === null) early.push(e.payload);
      else if (e.payload.id === termId) {
        const chunk = decoder.decode(b64ToBytes(e.payload.data), { stream: true });
        update(row, termId, (r) => ({ ...r, raw: (r.raw + chunk).slice(-OUTPUT_KEEP) }));
      }
    });
    try {
      const id = await invoke<string>("term_open", { cwd: workspace, ...PTY_SIZE });
      termId = id;
      shellsRef.current.add(id);
      const first = early
        .filter((e) => e.id === id)
        .map((e) => decoder.decode(b64ToBytes(e.data), { stream: true }))
        .join("");
      setRuns((prev) => ({ ...prev, [row]: { termId: id, command, raw: first, status: "running" } }));
      // Typed as if by hand, each line entered in turn.
      await invoke("term_write", { id, data: `${command.replace(/\r?\n/g, "\r")}\r` });
    } catch (err) {
      unlisten();
      setRuns((prev) => ({ ...prev, [row]: { termId: termId ?? "", command, raw: String(err), status: "error" } }));
      return;
    }
    const id = termId;

    // The terminal can't say "this command finished", but it can say whether the shell has a
    // child process: busy while it runs, idle again once the prompt is back.
    const startedAt = Date.now();
    let seenBusy = false;
    while (aliveRef.current) {
      await sleep(BUSY_POLL_MS);
      const busy = await invoke<string | null>("term_busy", { id }).catch(() => null);
      if (busy) seenBusy = true;
      else if (seenBusy || Date.now() - startedAt > BUILTIN_GRACE_MS) break;
    }
    // Give the shell a moment to print the rest and its prompt before marking it done.
    await sleep(150);
    unlisten();
    update(row, id, (r) => ({ ...r, status: "done" }));
  };

  const stop = (termId: string) => void invoke("term_write", { id: termId, data: "\x03" }).catch(() => {});

  const openInTerminal = (termId: string) => {
    adoptedRef.current.add(termId);
    openView?.("terminal");
    showInTerminal(termId);
  };

  const runLabel = tx.runIn.replace("{shell}", defaultToolPromptEnv().shell);
  // Boxes without output share the width of the longest line, so their buttons stay in one column.
  const widthCh = Math.max(...rows.flatMap((r) => r.text.split("\n").map((l) => l.length)));

  // Rows are grouped into boxes; a row that ran closes its box and gets its output right below.
  const boxes: { start: number; rows: CommandRow[] }[] = [];
  rows.forEach((row, i) => {
    const last = boxes[boxes.length - 1];
    if (last && !runs[i - 1]) last.rows.push(row);
    else boxes.push({ start: i, rows: [row] });
  });

  const renderRow = (row: CommandRow, i: number) => {
    const running = runs[i]?.status === "running";
    return (
      <Fragment key={i}>
        <pre className="py-0.5 font-mono text-[13px] leading-relaxed" style={{ minWidth: `${widthCh}ch` }}>
          <code className="whitespace-pre">{row.text ? <ShellCode code={row.text} /> : " "}</code>
        </pre>
        <div className="flex items-center gap-0.5">
          {row.command && closed && (
            running ? (
              <button type="button" onClick={() => stop(runs[i].termId)} aria-label={tx.stopCommand} data-tooltip={tx.stopCommand} className={ICON_BUTTON}>
                <Square className="h-3 w-3 fill-current" />
              </button>
            ) : (
              <button type="button" onClick={() => void start(i, row.command!)} aria-label={runLabel} data-tooltip={runLabel} className={ICON_BUTTON}>
                <Play className="h-3.5 w-3.5" />
              </button>
            )
          )}
          {row.command && (
            <button
              type="button"
              onClick={() => copy(i, row.command!)}
              aria-label={copiedRow === i ? tx.copied : tx.copy}
              data-tooltip={copiedRow === i ? tx.copied : tx.copy}
              className={ICON_BUTTON}
            >
              {copiedRow === i ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </Fragment>
    );
  };

  return (
    <div className="my-3">
      {boxes.map((box) => {
        const run = runs[box.start + box.rows.length - 1];
        return (
          <Fragment key={box.start}>
            {/* With output under it the box spans the panel's width, so Run, Copy and "Open in
                terminal" line up on the right edge. */}
            <div className={cn("my-1 max-w-full overflow-x-auto custom-scrollbar rounded-[6px] bg-bg-100 py-1.5 pl-3.5 pr-1.5", run ? "w-full" : "w-fit")}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                {box.rows.map((row, k) => renderRow(row, box.start + k))}
              </div>
            </div>
            {run && <RunOutput run={run} onOpen={() => openInTerminal(run.termId)} />}
          </Fragment>
        );
      })}
    </div>
  );
}

export default RunnableCommand;
