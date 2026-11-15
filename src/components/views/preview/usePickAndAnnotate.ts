import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { invoke } from "@/lib/ipc";
import { toPickedElement, type PickedElement } from "@/lib/pickedElement";
import { previewMessageTarget, type Bounds } from "@/lib/previewWebview";
import { ANNOT_COLORS, type AnnotShape, type AnnotTool } from "@/lib/annotations";
import { nextPaint } from "./helpers";

/** The element picker (Ctrl+Shift+S) and the annotation toolbar shown with it: picks and
 *  annotated screenshots go to the chat. */
export function usePickAndAnnotate({
  tabId,
  active,
  hasPage,
  extUrl,
  pickable,
  annotating,
  webviewHidden,
  loaded,
  iframeRef,
  contentRef,
  contentBounds,
  picking,
  setPicking,
  capturing,
  setCapturing,
  onPickElement,
  onAttachImage,
  messageTarget,
}: {
  tabId: string;
  active: boolean;
  hasPage: boolean;
  extUrl: string;
  pickable: boolean;
  annotating: boolean;
  webviewHidden: boolean;
  loaded: number;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  contentBounds: () => Bounds | null;
  picking: boolean;
  setPicking: Dispatch<SetStateAction<boolean>>;
  capturing: boolean;
  setCapturing: (capturing: boolean) => void;
  onPickElement?: (element: PickedElement) => void;
  onAttachImage?: (file: File) => void;
  /** Where the page's commands may go; a sandboxed frame has no origin to name, so it takes "*". */
  messageTarget?: string;
}) {
  // The annotation toolbar shown while picking: "select" is the element picker itself.
  const [annTool, setAnnTool] = useState<AnnotTool>("select");
  const [annShape, setAnnShape] = useState<AnnotShape>("rect");
  const [annColor, setAnnColor] = useState<string>(ANNOT_COLORS[0]);
  const [annWidth, setAnnWidth] = useState(4);
  const [annState, setAnnState] = useState({ count: 0, redo: 0 });
  const annCount = useRef(0);
  useEffect(() => { annCount.current = annState.count; }, [annState.count]);
  // Off after a pick that left drawings on the page: the toolbar stays so they aren't lost, but
  // the page gets its real clicks back until the picker is asked for again.
  const [pickArmed, setPickArmed] = useState(true);

  /** One pick per turn of the picker: once an element is picked the page gets its real clicks
   *  back, and the arrow button (or Ctrl+Shift+S) turns it on for the next one. Closing the
   *  toolbar would drop the drawings, so with some on the page only the picker stops. */
  const afterPick = useCallback(() => {
    if (annCount.current > 0) setPickArmed(false);
    else setPicking(false);
  }, [setPicking]);

  /** The address bar's arrow and Ctrl+Shift+S: a stopped picker over drawings starts again;
   *  otherwise they open or close the picker and its toolbar. */
  const togglePicker = useCallback(() => {
    if (picking && !pickArmed) {
      setAnnTool("select");
      setPickArmed(true);
      return;
    }
    setPickArmed(true);
    setPicking((p) => !p);
  }, [picking, pickArmed, setPicking]);

  /** The toolbar's tools; its arrow starts a stopped picker again. */
  const chooseTool = useCallback((tool: AnnotTool) => {
    setAnnTool(tool);
    if (tool === "select") setPickArmed(true);
  }, []);
  /** Hands a picked element to the chat, with a screenshot of its area (set further down,
   *  where the panel's bounds are known). */
  const deliverPick = useRef<(raw: unknown) => void>(() => {});
  const pickerOnRef = useRef(false);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as (PickedElement & { source?: string }) | null;
      if (!d || d.source !== "nyxs-pick") return;
      // Every tab listens; only the one whose page sent it answers.
      if (e.source !== iframeRef.current?.contentWindow) return;
      // A page's own scripts can post this too: it only counts while the picker is on.
      if (!pickerOnRef.current) return;
      deliverPick.current(d);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [iframeRef]);

  useEffect(() => {
    if (!active || !hasPage) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        togglePicker();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, hasPage, togglePicker]);

  // The element picker runs with the toolbar's arrow tool; drawing tools take the clicks instead.
  const pickerOn = picking && pickArmed && annTool === "select" && !capturing;
  useEffect(() => { pickerOnRef.current = pickerOn; }, [pickerOn]);

  useEffect(() => {
    if (extUrl) return;
    const win = iframeRef.current?.contentWindow;
    if (!win || (pickerOn && !pickable)) return;
    win.postMessage({ type: pickerOn ? "nyxs-pick-start" : "nyxs-pick-stop" }, "*");
  }, [pickerOn, loaded, pickable, extUrl, iframeRef]);

  useEffect(() => {
    if (!extUrl || !pickerOn || webviewHidden) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      const el = await invoke<unknown>("preview_pick", { tab: tabId, action: "take" }).catch(() => null);
      if (!alive) return;
      if (toPickedElement(el)) {
        deliverPick.current(el);
        return;
      }
      timer = window.setTimeout(() => void poll(), 250);
    };
    void invoke("preview_pick", { tab: tabId, action: "start" }).catch(() => {}).then(() => { if (alive) void poll(); });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      void invoke("preview_pick", { tab: tabId, action: "stop" }).catch(() => {});
    };
  }, [extUrl, pickerOn, webviewHidden, tabId]);

  /** Runs a command of the page's annotation layer (agent/preview_agent.js) and keeps the
   *  toolbar's undo/redo state from its answer. */
  const annotSeq = useRef(0);
  const annotRun = useCallback(
    async (cmd: string, args: Record<string, unknown> = {}) => {
      if (extUrl) {
        const reply = await invoke<string>("preview_agent_run", { tab: tabId, cmd, args, timeoutMs: 5_000 }).catch(() => "");
        try {
          const s = JSON.parse(reply) as { count?: unknown; redo?: unknown };
          if (typeof s.count === "number" && typeof s.redo === "number") setAnnState({ count: s.count, redo: s.redo });
        } catch { /* the page navigated or didn't answer */ }
        return;
      }
      const id = `annotate-${tabId}-${++annotSeq.current}`;
      iframeRef.current?.contentWindow?.postMessage({ source: "nyxs-agent", id, cmd, args }, messageTarget ?? previewMessageTarget(iframeRef.current.src));
    },
    [extUrl, tabId, iframeRef, messageTarget],
  );

  // Local pages report every change themselves.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { source?: string; state?: { count: number; redo: number } } | null;
      if (d?.source === "nyxs-annotations" && d.state) setAnnState(d.state);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [iframeRef]);

  // The page follows the toolbar (again after it navigates, which drops the layer).
  useEffect(() => {
    if (!annotating) return;
    void Promise.resolve().then(() => annotRun("annotate", { tool: annTool, color: annColor, width: annWidth }));
  }, [annotating, annTool, annColor, annWidth, loaded, annotRun]);

  // Websites can't post to the app: ask them for the undo state while drawing. The full
  // command (not just the state) also brings the layer back after a link changes the page.
  useEffect(() => {
    if (!annotating || !extUrl || webviewHidden) return;
    const id = window.setInterval(() => void annotRun("annotate", { tool: annTool, color: annColor, width: annWidth }), 700);
    return () => window.clearInterval(id);
  }, [annotating, extUrl, webviewHidden, annTool, annColor, annWidth, annotRun]);

  // Leaving the toolbar drops the drawings and starts the next time with the arrow.
  const wasAnnotating = useRef(false);
  useEffect(() => {
    if (annotating) { wasAnnotating.current = true; return; }
    if (!wasAnnotating.current) return;
    wasAnnotating.current = false;
    void Promise.resolve().then(() => {
      setAnnState({ count: 0, redo: 0 });
      setAnnTool("select");
      setPickArmed(true);
      return annotRun("annotate_end");
    });
  }, [annotating, annotRun]);

  /** Screenshot of the page with its drawings, without the toolbar, attached to the message. */
  const addAnnotatedShot = async () => {
    const b = contentBounds();
    if (!b || capturing) return;
    // Writes down a text still being typed.
    await annotRun("annotate", { commit: true });
    setCapturing(true);
    // The toolbar leaves the screen and the page closes its hole for it.
    await nextPaint();
    await new Promise((r) => setTimeout(r, 150));
    const png = await invoke<string>("preview_capture_png", { ...b, tab: extUrl ? tabId : null }).catch(() => null);
    setCapturing(false);
    if (!png) return;
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    onAttachImage?.(new File([bytes], `captura-${Date.now()}.png`, { type: "image/png" }));
    setPicking(false);
  };

  /** PNG data URL of the page around an element (`rect` in the page's viewport), with some
   *  margin so it reads in context, or undefined when it isn't on screen. */
  const shootElementArea = async (rect: { x: number; y: number; width: number; height: number }): Promise<string | undefined> => {
    // A website's webview starts at the panel's bounds; a local page's iframe at the content box.
    const b = contentBounds();
    const box = contentRef.current?.getBoundingClientRect();
    const origin = extUrl ? b : box ? { x: box.left, y: box.top, width: box.width, height: box.height } : null;
    if (!origin) return undefined;
    const pad = 24;
    let x = rect.x - pad;
    let y = rect.y - pad;
    let w = rect.width + pad * 2;
    let h = rect.height + pad * 2;
    if (w < 320) { x -= (320 - w) / 2; w = 320; }
    if (h < 160) { y -= (160 - h) / 2; h = 160; }
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(origin.width, x + w);
    const bottom = Math.min(origin.height, y + h);
    if (right - left < 8 || bottom - top < 8) return undefined;
    setCapturing(true);
    // The picker's highlight and the toolbar leave the screen first.
    await nextPaint();
    await new Promise((r) => setTimeout(r, 120));
    const area = { x: origin.x + left, y: origin.y + top, width: right - left, height: bottom - top };
    const png = await invoke<string>("preview_capture_png", { ...area, tab: extUrl ? tabId : null }).catch(() => null);
    setCapturing(false);
    return png ? `data:image/png;base64,${png}` : undefined;
  };

  useEffect(() => {
    deliverPick.current = (raw: unknown) => {
      const el = toPickedElement(raw);
      if (!el) return;
      void (async () => {
        const screenshot = el.rect ? await shootElementArea(el.rect) : undefined;
        onPickElement?.(screenshot ? { ...el, screenshot } : el);
        afterPick();
      })();
    };
  });

  return {
    annTool,
    chooseTool,
    pickArmed,
    togglePicker,
    annShape,
    setAnnShape,
    annColor,
    setAnnColor,
    annWidth,
    setAnnWidth,
    annState,
    annotRun,
    addAnnotatedShot,
  };
}
