import { useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import { ChevronDown, ChevronRight, Copy, Download, Loader2, Maximize2, Minimize2, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { PREVIEW_ORIGIN } from "@/lib/previewWebview";
import { visualThemeCss } from "@/lib/visualTheme";
import { setPanelVisual, usePanelVisual } from "@/lib/visualPanel";
import { useVisualBridge } from "@/lib/visualBridge";
import { copyVisualImage, saveVisualHtml } from "@/lib/visualActions";
import { Highlighted } from "./markdown";

const MIN_HEIGHT = 48;

function titleOf(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m?.[1].trim() || null;
}

interface Page {
  html: string;
  id: string | null;
  src: string | null;
}

/** A ```preview block: the agent's visual, drawn in the chat itself with the app's look. It lives
 *  on the preview protocol in a sandboxed iframe (scripts run, but it can't reach the app). */
export function InlinePreview({ html, closed }: { html: string; closed: boolean }) {
  const t = useTranslations().inlinePreview;
  const [page, setPage] = useState<Page | null>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const panelVisual = usePanelVisual();

  useEffect(() => {
    if (!closed) return;
    let alive = true;
    void (async () => {
      try {
        const themeCss = await visualThemeCss();
        const id = await invoke<string>("preview_mockup_put", { html, themeCss });
        if (alive) setPage({ html, id, src: `${PREVIEW_ORIGIN}/__nyxs/mockup/${id}` });
      } catch {
        if (alive) setPage({ html, id: null, src: null });
      }
    })();
    return () => { alive = false; };
  }, [html, closed]);

  useVisualBridge(frameRef, setHeight);

  // A click inside the visual never reaches the page, only takes the focus away from it.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => { document.removeEventListener("mousedown", close); window.removeEventListener("blur", close); };
  }, [menuOpen]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 1600);
  };

  const ready = page?.html === html ? page : null;
  const title = titleOf(html) ?? t.panelTitle;
  const inPanel = !!ready?.id && panelVisual?.id === ready.id;

  // A canvas follows the conversation: a visual the agent has just written replaces the one in
  // the panel, so asking for a change shows the result there. Visuals of a chat being read again
  // arrive already closed and leave the panel alone.
  const writing = useRef(!closed);
  useEffect(() => {
    if (!writing.current || !ready?.id || !ready.src) return;
    writing.current = false;
    if (panelVisual) setPanelVisual({ id: ready.id, src: ready.src, title });
  }, [ready, title, panelVisual]);

  const copyImage = async () => {
    setMenuOpen(false);
    const box = boxRef.current;
    if (!box) return;
    flash((await copyVisualImage(box)) ? t.imageCopied : t.copyFailed);
  };

  const download = async () => {
    setMenuOpen(false);
    if (!ready?.id) return;
    if (!(await saveVisualHtml(ready.id, title))) flash(t.saveFailed);
  };

  const iconBtn = "p-1 rounded-[6px] text-text-400 hover:text-text-200 hover:bg-bg-200 transition-colors";

  if (!closed || !ready) {
    return (
      <div className="my-2 flex items-center gap-1.5 text-[13px] text-text-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t.creating}
      </div>
    );
  }

  if (!ready.src) {
    return (
      <div className="my-2">
        <p className="mb-1.5 text-[13px] text-text-400">{t.unavailable}</p>
        <pre className="max-h-96 overflow-auto custom-scrollbar rounded-[8px] bg-[color:var(--code-bg)] p-3 text-[13px] leading-relaxed">
          <code className="font-mono whitespace-pre"><Highlighted code={html} lang="html" /></code>
        </pre>
      </div>
    );
  }

  return (
    <div className="my-2">
      <div className="flex items-center gap-0.5 text-[13px] text-text-400">
        <button type="button" onClick={() => setCollapsed((c) => !c)} className="flex items-center gap-1 rounded-[6px] py-0.5 hover:text-text-200 transition-colors">
          {t.created}
          {collapsed && <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        {!collapsed && !inPanel && (
          <button
            type="button"
            onClick={() => setPanelVisual({ id: ready.id!, src: ready.src!, title })}
            aria-label={t.showInPanel}
            data-tooltip={t.showInPanel}
            className={iconBtn}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
        {!collapsed && (
          <button type="button" onClick={() => setCollapsed(true)} aria-label={t.collapse} className={iconBtn}>
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {collapsed ? null : inPanel ? (
        <div className="mt-0.5 flex items-center gap-2 text-[12.5px] text-text-500">
          {t.inOtherPanel}
          <button type="button" onClick={() => setPanelVisual(null)} className="flex items-center gap-1 text-text-300 hover:text-text-100 transition-colors">
            <Minimize2 className="h-3 w-3" />
            {t.showHere}
          </button>
        </div>
      ) : (
        <div ref={boxRef} className="group relative mt-1.5 overflow-hidden rounded-[8px] border border-bg-300 bg-bg-100 p-3">
          <iframe
            ref={frameRef}
            src={ready.src}
            title={title}
            sandbox="allow-scripts allow-forms"
            className="block w-full bg-transparent"
            style={{ height: Math.max(height, MIN_HEIGHT) }}
          />
          <div ref={menuRef} className={cn("absolute right-2 top-2", menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 transition-opacity")}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={t.more}
              aria-expanded={menuOpen}
              className={cn("rounded-[6px] p-1 text-text-400 hover:bg-bg-200 hover:text-text-200 transition-colors", menuOpen && "bg-bg-200 text-text-200")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-52 rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg">
                <button type="button" role="menuitem" onClick={() => void copyImage()} className="flex w-full items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-text-200 hover:bg-bg-200">
                  <Copy className="h-4 w-4 text-text-400" />
                  {t.copyImage}
                </button>
                <button type="button" role="menuitem" onClick={() => void download()} className="flex w-full items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-text-200 hover:bg-bg-200">
                  <Download className="h-4 w-4 text-text-400" />
                  {t.downloadHtml}
                </button>
              </div>
            )}
          </div>
          {notice && (
            <div className="pointer-events-none absolute bottom-2 right-2 rounded-[6px] bg-bg-300 px-2 py-1 text-[12px] text-text-100 shadow-sm animate-fade-in">
              {notice}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
