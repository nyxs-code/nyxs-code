import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import { tokenize, langFromPath } from "@/lib/highlight";
import { localizedError, useTranslations } from "@/lib/i18n";
import { indentLines, indentUnit, toLines } from "@/lib/fileEditing";
import { autoSaveFiles } from "@/lib/featureSettings";
import { fileActivity } from "@/lib/fileActivity";

const LINE = "leading-[20px] font-mono text-[12.5px]";
const AUTO_SAVE_MS = 800;
const CHANGED_ON_DISK = /changed on disk/i;

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "conflict" } | { kind: "error"; message: string };

/** What the Files panel needs to ask before leaving the file: changes that would be lost (auto
 *  save off), and a save that says whether it landed. */
export interface LeaveGuard {
  unsaved: boolean;
  save: () => Promise<boolean>;
}

/** A file in the Files panel, editable like Claude Code Desktop's file pane: a transparent text
 *  box over the highlighted code. Saves on its own after a pause (or with Save, when auto save is
 *  off in Settings), and never overwrites a change made on disk meanwhile without asking. */
export function FileEditor({ path, diskText, diskMtime, readOnly, onLeaveGuard }: {
  path: string;
  diskText: string;
  diskMtime: number | null;
  readOnly: boolean;
  /** Gets the editor's guard while it's mounted, and `null` when it goes. */
  onLeaveGuard?: (guard: LeaveGuard | null) => void;
}) {
  const t = useTranslations().fileEditor;
  const [text, setText] = useState(diskText);
  const [saved, setSaved] = useState(diskText);
  const [mtime, setMtime] = useState(diskMtime);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [seenDisk, setSeenDisk] = useState({ text: diskText, mtime: diskMtime });
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== saved;
  const autoSave = autoSaveFiles();

  // The file changed on disk (the agent, another editor): taken in when nothing is unsaved,
  // otherwise the user chooses.
  if (seenDisk.text !== diskText || seenDisk.mtime !== diskMtime) {
    setSeenDisk({ text: diskText, mtime: diskMtime });
    if (!dirty) {
      setText(diskText);
      setSaved(diskText);
      setMtime(diskMtime);
    } else if (diskMtime !== mtime && diskText !== saved) {
      setStatus({ kind: "conflict" });
    }
  }

  // The mtime the next save expects, set as soon as a save lands: a save still on its way when
  // the editor closes finishes after the last render.
  const mtimeRef = useRef(diskMtime);
  useEffect(() => { mtimeRef.current = mtime; }, [mtime]);
  // Saves run one after another, each against the file the one before left; otherwise a save made
  // while another is on its way takes that one for a change on disk.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  /** Resolves to whether the file was written. */
  const save = (force = false): Promise<boolean> => {
    if (readOnly) return Promise.resolve(false);
    const content = text;
    setStatus({ kind: "saving" });
    const run = queueRef.current.then(async () => {
      try {
        await invoke("agent_write_file", { path, content, expectedMtime: force ? null : mtimeRef.current });
        // So "Revertir" never takes this save for what an agent's command did meanwhile.
        fileActivity.wrote("user", path);
        setSaved(content);
        const next = await invoke<number | null>("agent_file_mtime", { path }).catch(() => null);
        mtimeRef.current = next;
        setMtime(next);
        setStatus({ kind: "idle" });
        return true;
      } catch (e) {
        const message = localizedError(e);
        setStatus(CHANGED_ON_DISK.test(message) ? { kind: "conflict" } : { kind: "error", message });
        return false;
      }
    });
    queueRef.current = run;
    return run;
  };
  const canAutoSave = autoSave && dirty && !readOnly && status.kind !== "conflict";
  const latest = useRef({ save, canAutoSave });
  useEffect(() => { latest.current = { save, canAutoSave }; });

  useEffect(() => {
    if (!canAutoSave) return;
    const timer = setTimeout(() => void latest.current.save(), AUTO_SAVE_MS);
    return () => clearTimeout(timer);
  }, [text, canAutoSave]);

  // Opening another file or closing the panel unmounts the editor before the pause is over:
  // what was typed last is saved then, as the auto save would have.
  useEffect(() => {
    const live = latest;
    return () => {
      if (live.current.canAutoSave) void live.current.save();
    };
  }, []);

  // With auto save off, changes the user hasn't saved are theirs to keep or drop before leaving.
  const unsaved = !autoSave && dirty && !readOnly;
  useEffect(() => {
    if (!onLeaveGuard) return;
    onLeaveGuard({ unsaved, save: () => latest.current.save() });
    return () => onLeaveGuard(null);
  }, [onLeaveGuard, unsaved]);

  const discard = async () => {
    const fresh = await invoke<string | null>("agent_read_text", { path }).catch(() => null);
    const next = (fresh ?? saved).replace(/\r\n?/g, "\n");
    setText(next);
    setSaved(next);
    setMtime(await invoke<number | null>("agent_file_mtime", { path }).catch(() => null));
    setStatus({ kind: "idle" });
  };

  const lines = useMemo(() => toLines(tokenize(text, langFromPath(path))), [text, path]);

  // The text box is as tall as the file and the panel scrolls, so the panel follows the caret.
  const scrollRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const followCaret = () => {
    const el = areaRef.current;
    const box = scrollRef.current;
    if (!el || !box) return;
    const line = el.value.slice(0, el.selectionStart).split("\n").length - 1;
    // A wrapped line is taller than 20px, so the caret's row is measured, not counted.
    const row = preRef.current?.children[line] as HTMLElement | undefined;
    const top = row?.offsetTop ?? line * 20;
    const bottom = top + Math.min(row?.offsetHeight ?? 20, box.clientHeight - 8) + 8;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  };
  const unit = useMemo(() => indentUnit(saved), [saved]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
    }
    if (readOnly || e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = el;
    let next: { text: string; start: number; end: number };
    if (start === end && !e.shiftKey) {
      next = { text: text.slice(0, start) + unit + text.slice(end), start: start + unit.length, end: start + unit.length };
    } else {
      next = indentLines(text, start, end, unit, e.shiftKey);
    }
    setText(next.text);
    requestAnimationFrame(() => {
      el.selectionStart = next.start;
      el.selectionEnd = next.end;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(status.kind === "conflict" || status.kind === "error" || (!autoSave && dirty)) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-bg-300 bg-bg-100 px-4 py-1.5 text-[12.5px]">
          <span className={status.kind === "error" ? "min-w-0 flex-1 truncate text-red-500" : "min-w-0 flex-1 truncate text-text-200"}>
            {status.kind === "conflict" ? t.conflict : status.kind === "error" ? status.message : t.unsaved}
          </span>
          {status.kind === "conflict" ? (
            <>
              <button type="button" onClick={() => void discard()} className="px-2.5 py-0.5 rounded-[6px] border border-bg-300 bg-bg-0 text-text-200 hover:bg-bg-200">{t.discard}</button>
              <button type="button" onClick={() => void save(true)} className="px-2.5 py-0.5 rounded-[6px] bg-text-100 font-medium text-bg-0 hover:opacity-90">{t.overwrite}</button>
            </>
          ) : status.kind !== "error" ? (
            <>
              <button type="button" onClick={() => setText(saved)} className="px-2.5 py-0.5 rounded-[6px] border border-bg-300 bg-bg-0 text-text-200 hover:bg-bg-200">{t.cancel}</button>
              <button type="button" onClick={() => void save()} className="px-2.5 py-0.5 rounded-[6px] bg-text-100 font-medium text-bg-0 hover:opacity-90">{t.save}</button>
            </>
          ) : null}
        </div>
      )}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
        <div className="pb-4 pl-12">
          <div className="relative">
            {/* Long lines wrap, like the chat, so there is no sideways scroll. The text box wraps
                the same way over it, and each number sits beside its row, however tall it gets. */}
            <pre ref={preRef} aria-hidden className={`m-0 whitespace-pre-wrap break-words pr-6 ${LINE}`}>
              {lines.map((line, i) => (
                <div key={i} className="relative">
                  <span className="absolute right-full w-12 select-none pr-4 text-right tabular-nums text-text-500">{i + 1}</span>
                  {line.length === 0 ? " " : line.map((tok, j) => <span key={j} className={tok.cls}>{tok.text}</span>)}
                </div>
              ))}
            </pre>
            <textarea
              ref={areaRef}
              value={text}
              onChange={(e) => { setText(e.target.value); requestAnimationFrame(followCaret); }}
              onKeyDown={onKeyDown}
              onKeyUp={followCaret}
              onClick={followCaret}
              readOnly={readOnly}
              spellCheck={false}
              wrap="soft"
              aria-label={path}
              className={`absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 pr-6 text-transparent outline-none selection:bg-accent/25 ${LINE} ${readOnly ? "cursor-default" : ""}`}
              style={{ caretColor: "var(--text-100)" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
