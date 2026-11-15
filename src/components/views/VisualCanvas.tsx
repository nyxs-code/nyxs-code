import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Maximize2, Minimize2, MoreVertical, RotateCw, Shapes, X } from "lucide-react";
import { CursorIcon } from "@/components/ui/cursor-icon";
import { VIEWPORT_SIZES, type Viewport } from "@/lib/browserPrefs";
import { useTranslations } from "@/lib/i18n";
import type { PickedElement } from "@/lib/pickedElement";
import { ACTIVE_TOGGLE } from "@/lib/uiClasses";
import { cn } from "@/lib/utils";
import { copyVisualImage, saveVisualHtml } from "@/lib/visualActions";
import { useVisualBridge } from "@/lib/visualBridge";
import { canvasSrc, type PanelVisual } from "@/lib/visualPanel";
import { AnnotationBar } from "./AnnotationBar";
import { PICK_SHORTCUT } from "./preview/helpers";
import { PickElementTip } from "./preview/PickElementTip";
import { usePageShortcuts } from "./preview/usePageShortcuts";
import { usePickAndAnnotate } from "./preview/usePickAndAnnotate";

const VIEWPORTS: Viewport[] = ["responsive", "mobile", "tablet", "desktop"];

const iconButton = "p-1.5 rounded-[6px] text-text-400 hover:text-text-200 hover:bg-bg-200";
const menuRow = "flex w-full items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-text-200 hover:bg-bg-200";

/** A visual from the chat, moved to the side panel with "Show in another panel": it works like a
 *  page of the browser panel, with the same element picker and drawing tools. */
export function VisualCanvas({
  visual,
  active,
  onClose,
  onToggleMaximize,
  maximized,
  onPickElement,
  onAttachImage,
}: {
  visual: PanelVisual;
  /** Whether Ctrl+Shift+S is for this pane: an open browser panel keeps it. */
  active: boolean;
  onClose: () => void;
  onToggleMaximize: () => void;
  maximized: boolean;
  onPickElement?: (element: PickedElement) => void;
  onAttachImage?: (file: File) => void;
}) {
  const t = useTranslations();
  const tv = t.views;
  const ti = t.inlinePreview;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [viewport, setViewport] = useState<Viewport>("responsive");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickTip, setPickTip] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Another visual took the panel: the drawings were on the last one's page.
  const src = canvasSrc(visual.src);
  const [shownSrc, setShownSrc] = useState(src);
  if (src !== shownSrc) {
    setShownSrc(src);
    setPicking(false);
  }

  const contentBounds = useCallback(() => {
    const r = contentRef.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  }, []);

  useVisualBridge(frameRef);
  usePageShortcuts("visual", frameRef);
  const { annTool, chooseTool, pickArmed, togglePicker, annShape, setAnnShape, annColor, setAnnColor, annWidth, setAnnWidth, annState, annotRun, addAnnotatedShot } =
    usePickAndAnnotate({
      tabId: "visual",
      active,
      hasPage: true,
      extUrl: "",
      pickable: true,
      annotating: picking,
      webviewHidden: false,
      loaded,
      iframeRef: frameRef,
      contentRef,
      contentBounds,
      picking,
      setPicking,
      capturing,
      setCapturing,
      onPickElement,
      onAttachImage,
      messageTarget: "*",
    });

  // A click inside the visual never reaches the app, only takes the focus away from it.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && menuRef.current?.contains(e.target as Node)) return;
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [menuOpen]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 1600);
  };

  const reload = () => {
    setPicking(false);
    setReloadKey((k) => k + 1);
  };

  const copyImage = async () => {
    setMenuOpen(false);
    const box = contentRef.current;
    if (!box) return;
    // The toolbar and the picker's highlight stay out of the picture; the drawings go in it.
    setCapturing(true);
    const copied = await copyVisualImage(box);
    setCapturing(false);
    flash(copied ? ti.imageCopied : ti.copyFailed);
  };

  const download = async () => {
    setMenuOpen(false);
    if (!(await saveVisualHtml(visual.id, visual.title))) flash(ti.saveFailed);
  };

  const viewportLabel: Record<Viewport, string> = {
    responsive: tv.viewportResponsive,
    mobile: tv.viewportMobile,
    tablet: tv.viewportTablet,
    desktop: tv.viewportDesktop,
  };
  const vpSize = viewport === "responsive" ? null : VIEWPORT_SIZES[viewport];

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-medium text-text-100">
          <Shapes className="w-4 h-4 shrink-0 text-text-300" />
          <span className="truncate">{visual.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="relative" onMouseEnter={() => setPickTip(true)} onMouseLeave={() => setPickTip(false)}>
            <button
              type="button"
              onClick={togglePicker}
              aria-label={tv.selectElement}
              aria-pressed={picking && pickArmed}
              aria-keyshortcuts={PICK_SHORTCUT}
              className={cn("block p-1 rounded-[6px]", picking && pickArmed ? ACTIVE_TOGGLE : "text-text-400 hover:text-text-200 hover:bg-bg-200")}
            >
              <CursorIcon className="w-[18px] h-[18px]" />
            </button>
            {pickTip && !picking && <PickElementTip />}
          </div>
          <button type="button" onClick={reload} aria-label={tv.reload} className={iconButton}>
            <RotateCw className="w-4 h-4" />
          </button>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={ti.more}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={cn(iconButton, menuOpen && "bg-bg-200 text-text-200")}
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div role="menu" aria-label={ti.more} data-webview-hole className="absolute right-0 top-full z-50 mt-1 w-60 rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg">
                <button type="button" role="menuitem" onClick={() => void copyImage()} className={menuRow}>
                  <Copy className="h-4 w-4 shrink-0 text-text-400" />
                  {ti.copyImage}
                </button>
                <button type="button" role="menuitem" onClick={() => void download()} className={menuRow}>
                  <Download className="h-4 w-4 shrink-0 text-text-400" />
                  {ti.downloadHtml}
                </button>
                <div className="my-1 mx-1 border-t border-bg-300" />
                <div className="px-2 pt-1 pb-1 text-[12px] text-text-400">{tv.viewport}</div>
                {VIEWPORTS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="menuitemradio"
                    aria-checked={viewport === v}
                    onClick={() => { setViewport(v); setMenuOpen(false); }}
                    className={menuRow}
                  >
                    <Check className={cn("h-4 w-4 shrink-0 text-accent", viewport !== v && "invisible")} />
                    <span className="min-w-0 flex-1 truncate">{viewportLabel[v]}</span>
                    {v !== "responsive" && (
                      <span className="shrink-0 text-[12px] tabular-nums text-text-400">
                        {VIEWPORT_SIZES[v].width} × {VIEWPORT_SIZES[v].height}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" onClick={onToggleMaximize} aria-label={maximized ? tv.showChat : tv.diffExpandPanel} className={iconButton}>
            {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button type="button" onClick={onClose} aria-label={tv.close} className={iconButton}>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className={cn("relative flex flex-1 min-h-0", vpSize ? "items-center justify-center overflow-hidden bg-bg-200 p-3" : "px-3 pb-3")}>
        <div
          ref={contentRef}
          className={cn(vpSize ? "bg-bg-100 shadow-sm ring-1 ring-bg-300" : "min-w-0 flex-1")}
          style={vpSize ? { width: vpSize.width, height: vpSize.height, maxWidth: "100%", maxHeight: "100%" } : undefined}
        >
          <iframe
            key={`${src}:${reloadKey}`}
            ref={frameRef}
            src={src}
            title={visual.title}
            sandbox="allow-scripts allow-forms"
            onLoad={() => setLoaded((n) => n + 1)}
            className="block h-full w-full border-0 bg-transparent"
          />
        </div>
        {picking && !capturing && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100%-1rem)]">
            <AnnotationBar
              tool={pickArmed ? annTool : null}
              shape={annShape}
              color={annColor}
              width={annWidth}
              canUndo={annState.count > 0}
              canRedo={annState.redo > 0}
              canClear={annState.count > 0}
              onTool={chooseTool}
              onShape={setAnnShape}
              onColor={setAnnColor}
              onWidth={setAnnWidth}
              onUndo={() => void annotRun("annotate_undo")}
              onRedo={() => void annotRun("annotate_redo")}
              onClear={() => void annotRun("annotate_clear")}
              onAddToChat={() => void addAnnotatedShot()}
              onClose={() => setPicking(false)}
            />
          </div>
        )}
        {notice && (
          <div role="status" className="pointer-events-none absolute bottom-3 right-3 rounded-[6px] bg-bg-300 px-2 py-1 text-[12px] text-text-100 shadow-sm animate-fade-in">
            {notice}
          </div>
        )}
      </div>
    </>
  );
}
