import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import { invoke } from "@/lib/ipc";
import { ansiRuns, type AnsiColor } from "@/lib/ansi";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { lineLevel } from "./logLevel";

/** Only the tail of a chatty server is kept on screen. */
const KEEP_LINES = 2000;
const HEIGHT_KEY = "nyxs.preview.serverLogsHeight";
const DEFAULT_HEIGHT = 200;
const MIN_HEIGHT = 80;
/** What the page keeps at least when the panel is dragged up. */
const PAGE_MIN = 120;

const ANSI_CLASS: Record<AnsiColor, string> = {
  red: "text-danger",
  green: "text-success",
  yellow: "text-warning",
  blue: "text-[color:var(--link)]",
  magenta: "text-fuchsia-600 dark:text-fuchsia-400",
  cyan: "text-cyan-700 dark:text-cyan-400",
  gray: "text-text-400",
};

const LogLine = memo(function LogLine({ line }: { line: string }) {
  const runs = useMemo(() => ansiRuns(line), [line]);
  const level = lineLevel(line);
  return (
    <div className={cn("whitespace-pre-wrap break-all", level === "error" && "text-danger", level === "warn" && "text-warning")}>
      {runs.length === 0
        ? "​"
        : runs.map((r, i) => (
            <span key={i} className={cn(r.color && ANSI_CLASS[r.color], r.bold && "font-semibold", r.dim && "opacity-60")}>
              {r.text}
            </span>
          ))}
    </div>
  );
});

function savedHeight(): number {
  const n = Number(localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT;
}

/**
 * The output of the dev server the preview shows, in a panel under the page, as Claude Code
 * Desktop's "Dev server logs": what it printed so far, then live, following the end unless the
 * user scrolled up to read. Its top edge resizes it; the height is kept for next time.
 */
export function DevServerLogs({ shellId, title, onClose }: { shellId: string; title: string; onClose: () => void }) {
  const t = useTranslations().views;
  const [lines, setLines] = useState<string[]>([]);
  const [height, setHeight] = useState(savedHeight);
  const boxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // A new server's logs come with a new panel (PreviewPage keys it by the shell).
  useEffect(() => {
    let alive = true;
    // Read by offset, waiting for what comes next: each line arrives once and in order, what was
    // printed before the panel opened included.
    void (async () => {
      let offset = 0;
      while (alive) {
        const r = await invoke<{ output: string; nextOffset: number; status: string }>("agent_bg_output", { id: shellId, after: offset, waitMs: 1500 }).catch(() => null);
        if (!alive || !r) return;
        offset = r.nextOffset;
        const text = r.output.replace(/\n$/, "");
        if (text) {
          const next = text.split(/\r?\n/);
          setLines((cur) => {
            const all = cur.concat(next);
            return all.length > KEEP_LINES ? all.slice(-KEEP_LINES) : all;
          });
        }
        // The server ended: nothing more will come.
        if (r.status !== "running" && !text) return;
      }
    })();
    return () => {
      alive = false;
    };
  }, [shellId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [lines, height]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };

  const maxHeight = () => {
    const page = boxRef.current?.parentElement?.getBoundingClientRect().height ?? 600;
    return Math.max(MIN_HEIGHT, page - PAGE_MIN);
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const max = maxHeight();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let last = startH;
    const move = (ev: PointerEvent) => {
      last = Math.min(max, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)));
      setHeight(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      localStorage.setItem(HEIGHT_KEY, String(Math.round(last)));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const onResizeKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const next = Math.min(maxHeight(), Math.max(MIN_HEIGHT, height + (e.key === "ArrowUp" ? 16 : -16)));
    setHeight(next);
    localStorage.setItem(HEIGHT_KEY, String(next));
  };

  return (
    <section ref={boxRef} aria-label={t.serverLogs} className="relative flex shrink-0 flex-col border-t border-bg-300 bg-bg-0" style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t.resizeServerLogs}
        aria-valuenow={Math.round(height)}
        aria-valuemin={MIN_HEIGHT}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onResizeKey}
        className="absolute inset-x-0 -top-[3px] z-10 h-1.5 cursor-ns-resize focus-visible:bg-accent/40 hover:bg-accent/30"
      />
      <div className="flex h-[30px] shrink-0 items-center pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-400" title={title}>{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.closeServerLogs}
          data-tooltip={t.closeServerLogs}
          className="shrink-0 rounded p-1 text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={scrollRef} onScroll={onScroll} role="log" className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-3 pb-2.5 font-mono text-[11.5px] leading-[17px] text-text-300 select-text">
        {lines.length === 0 ? (
          <p className="pt-2 text-center font-sans text-text-400">{t.serverLogsWaiting}</p>
        ) : (
          lines.map((line, i) => <LogLine key={i} line={line} />)
        )}
      </div>
    </section>
  );
}
