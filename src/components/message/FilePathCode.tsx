import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "@/lib/i18n";
import { invoke } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useCloseOnBlur } from "@/lib/useCloseOnBlur";
import { clickablePaths } from "@/lib/featureSettings";
import {
  attachPathRef,
  currentWorkspace,
  installedEditors,
  openPathRef,
  parsePathRef,
  pathKind,
  type EditorInfo,
  type PathKind,
  type PathRef,
} from "@/lib/filePaths";

const CODE_CLS =
  "px-1 py-px rounded-[4px] [box-decoration-break:clone] border border-[color:var(--inline-code-border)] bg-[color:var(--inline-code-bg)] font-mono text-[12.5px] text-[color:var(--inline-code-fg)]";

/** Inline code in a message. When it names a file or folder that exists, like Claude Code
 *  Desktop it opens on click and has a menu on right-click: attach it to the message, open it
 *  in an editor, show it in the file manager, copy its path. */
export function InlineCode({ text }: { text: string }) {
  const [ref] = useState<PathRef | null>(() => (clickablePaths() ? parsePathRef(text, currentWorkspace()) : null));
  const [kind, setKind] = useState<PathKind>("none");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!ref) return;
    let alive = true;
    void pathKind(ref.abs).then((k) => { if (alive) setKind(k); });
    return () => { alive = false; };
  }, [ref]);

  if (!ref || kind === "none") return <code className={CODE_CLS}>{text}</code>;
  return (
    <>
      <code
        role="link"
        tabIndex={0}
        onClick={() => openPathRef(ref, kind)}
        onKeyDown={(e) => { if (e.key === "Enter") openPathRef(ref, kind); }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={cn(CODE_CLS, "cursor-pointer hover:underline underline-offset-2 decoration-[color:var(--link)]")}
      >
        {text}
      </code>
      {menu && <PathMenu at={menu} pathRef={ref} kind={kind} onClose={() => setMenu(null)} />}
    </>
  );
}

function PathMenu({ at, pathRef, kind, onClose }: { at: { x: number; y: number }; pathRef: PathRef; kind: PathKind; onClose: () => void }) {
  const t = useTranslations().filePath;
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useCloseOnBlur(true, onClose);

  useEffect(() => {
    let alive = true;
    void installedEditors().then((e) => { if (alive) setEditors(e); });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { alive = false; window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  // Kept inside the window when opened near an edge.
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4));
    const y = at.y + r.height > window.innerHeight - 4 ? Math.max(4, at.y - r.height) : at.y;
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [at, editors.length, pos.x, pos.y]);

  const run = (fn: () => void) => () => { fn(); onClose(); };
  const copy = (s: string) => run(() => void navigator.clipboard.writeText(s).catch(() => undefined));
  const file = kind === "file";
  const item = "block w-full whitespace-nowrap text-left px-2 py-1 rounded-[6px] text-[13px] text-text-100 hover:bg-bg-200 transition-colors";

  return createPortal(
    <>
      <div className="fixed inset-0 z-[90]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} aria-hidden />
      <div
        data-mod-menu
        ref={box}
        role="menu"
        data-webview-hole
        className="fixed z-[91] w-max min-w-[150px] rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg"
        style={{ left: pos.x, top: pos.y }}
      >
        <button type="button" role="menuitem" className={item} onClick={run(() => openPathRef(pathRef, kind))}>{t.open}</button>
        {file && <button type="button" role="menuitem" className={item} onClick={run(() => attachPathRef(pathRef))}>{t.attach}</button>}
        {file && editors.map((ed) => (
          <button
            key={ed.id}
            type="button"
            role="menuitem"
            className={item}
            onClick={run(() => void invoke("agent_open_in_editor", { editor: ed.id, path: pathRef.abs, line: pathRef.line ?? null }).catch(() => undefined))}
          >
            {t.openIn.replace("{editor}", ed.name)}
          </button>
        ))}
        <button type="button" role="menuitem" className={item} onClick={run(() => void invoke("agent_reveal_path", { path: pathRef.abs }).catch(() => undefined))}>
          {t.showInFolder}
        </button>
        <div className="my-1 h-px bg-bg-300" />
        <button type="button" role="menuitem" className={item} onClick={copy(pathRef.abs)}>{t.copyAbsolute}</button>
        <button type="button" role="menuitem" className={item} onClick={copy(pathRef.rel)}>{t.copyRelative}</button>
        <button type="button" role="menuitem" className={item} onClick={copy(pathRef.name)}>{t.copyName}</button>
      </div>
    </>,
    document.body,
  );
}
