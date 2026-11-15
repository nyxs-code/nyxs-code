import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/ipc";
import { isRemotePath, tunnelUrl } from "@/lib/remote";
import {
  currentPreviewNav,
  goPreviewHistory,
  nextPreviewNav,
  reloadPreviewWebview,
  type PreviewNavReport,
} from "@/lib/previewWebview";
import type { PreviewPageInfo } from "@/lib/previewControl";
import { cookieProfile, getBrowserPrefs } from "@/lib/browserPrefs";
import { browserSearch } from "@/lib/featureSettings";
import { searchUrl } from "@/lib/searchEngines";
import { joinPath } from "@/tools/paths";
import type { PageSnapshot } from "./helpers";
import { applyNavReport, pushAddress, type NavContext, type PageHistory } from "./pageHistory";
import { classifyAddress } from "./addressInput";

/** The project's files relative to it, with `/` (the backend lists them relative; a list with
 *  full paths is cut down to the same form). */
export function relativeFiles(workspace: string, files: readonly string[]): string[] {
  const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return files.map((f) => {
    const p = f.replace(/\\/g, "/");
    return p.toLowerCase().startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
  });
}

/** Opens an address in the tab (see `loadTarget` below). */
export type LoadTarget = (value: string, isManual: boolean, fromHistory?: boolean) => Promise<PreviewPageInfo["kind"]>;

/** A tab's address bar and history, and what its page shows: a website (`extUrl`, in the
 *  native webview) or a local page or file (`src`, in an iframe). */
export function usePageAddress({
  workspace,
  tabId,
  fresh,
  restored,
  setMenuOpen,
  onUserLoad,
}: {
  workspace: string | null;
  tabId: string;
  fresh: boolean;
  restored?: PageSnapshot;
  setMenuOpen: (open: boolean) => void;
  /** The user opened a new address in the tab (not its history, nor the agent). */
  onUserLoad?: (tabId: string) => void;
}) {
  const [input, setInput] = useState("");
  const [src, setSrc] = useState("");
  const [extUrl, setExtUrlState] = useState("");
  // A restored tab stays on its page rather than following whichever dev server shows up first.
  const [manual, setManual] = useState(fresh || !!restored?.manual || !!restored?.input);
  const [reloadKey, setReloadKey] = useState(0);
  // Back/forward over the pages opened in this preview, like a browser.
  const [urlFocused, setUrlFocusedState] = useState(false);
  const [hist, setHist] = useState<PageHistory>(() => restored?.hist ?? { list: [], i: -1 });
  /** What the website's own history allows, from its last report (null until one arrives). */
  const [web, setWeb] = useState<{ canBack: boolean | null; canForward: boolean | null } | null>(null);
  const targetRef = useRef<{ origin?: string; root?: string } | null>(null);

  // Read by the page's reports, which arrive outside React's render.
  const extRef = useRef("");
  const histRef = useRef(hist);
  const focusRef = useRef(false);
  /** Times the bar got the focus, so an address worked out late knows the user came back to it. */
  const focuses = useRef(0);
  const navCtx = useRef<NavContext>({ last: null, replaceNext: false });
  useEffect(() => { histRef.current = hist; }, [hist]);
  // Set together with the state, not in an effect: an address that arrives right after the user
  // clicks into the bar must already see them typing.
  const setUrlFocused = useCallback((focused: boolean) => {
    if (focused && !focusRef.current) focuses.current++;
    focusRef.current = focused;
    setUrlFocusedState(focused);
  }, []);
  /** Changes to the address made from outside (the user typing, Escape), so an address that
   *  finishes loading late doesn't write over them. */
  const edits = useRef(0);
  /** Counts the addresses opened in this tab: one still waiting (the file list, a tunnel, its
   *  site) when another was opened gives up, so it can't replace the newer page. */
  const loads = useRef(0);
  const setInputFromOutside = useCallback((v: string) => {
    edits.current++;
    setInput(v);
  }, []);

  /** The website the tab asks for. A new address starts a new navigation of its page, so a
   *  late report about the page being left can't pull the tab back to it. */
  const setExtUrl = useCallback(
    (v: string | ((cur: string) => string)) => {
      const next = typeof v === "function" ? v(extRef.current) : v;
      if (next === extRef.current) return;
      extRef.current = next;
      nextPreviewNav(tabId);
      navCtx.current = { last: null, replaceNext: !!next };
      if (!next) setWeb(null);
      setExtUrlState(next);
    },
    [tabId],
  );

  // A link, a form, a redirect or a script in the website moved it: the address bar and the
  // history follow, without opening anything again (the page already is there).
  useEffect(() => {
    const unlisten = listen<PreviewNavReport>("preview-nav", ({ payload: r }) => {
      if (r.tab !== tabId || r.nav !== currentPreviewNav(tabId) || !extRef.current) return;
      const next = applyNavReport(histRef.current, r, navCtx.current);
      navCtx.current = { last: { length: r.length, canForward: r.canForward }, replaceNext: false };
      histRef.current = next;
      setHist(next);
      setWeb({ canBack: r.canBack, canForward: r.canForward });
      if (r.url !== extRef.current) {
        extRef.current = r.url;
        setExtUrlState(r.url);
      }
      // Never over what the user is typing.
      if (!focusRef.current) setInput(r.url);
    });
    return () => { void unlisten.then((f) => f()); };
  }, [tabId]);

  // The project's files, for opening one by its name. Listed only when such a word is entered
  // (not while typing: the suggestions offer no files), so new files are always found.
  const loadFiles = useCallback(
    (): Promise<string[]> =>
      workspace
        ? invoke<string[]>("agent_list_files", { workspace }).then((all) => relativeFiles(workspace, all ?? []), () => [])
        : Promise.resolve([]),
    [workspace],
  );

  /** Opens an address in this tab and says what kind of page it turned out to be. */
  const loadTarget = useCallback<LoadTarget>(
    async (value: string, isManual: boolean, fromHistory = false): Promise<PreviewPageInfo["kind"]> => {
      let v = value.trim();
      const load = ++loads.current;
      const superseded = () => load !== loads.current;
      const editsAtStart = edits.current;
      const focusesAtStart = focuses.current;
      if (isManual) setManual(true);
      if (isManual && !fromHistory) onUserLoad?.(tabId);
      setMenuOpen(false);
      if (!v) { setInput(""); setSrc(""); setExtUrl(""); return "empty"; }

      // Only a single word typed by hand can be a project file's name; anything else needs no list.
      const maybeFile = isManual && !fromHistory && !/\s/.test(v) && !/^[a-z]+:\/\//i.test(v);
      const files = maybeFile ? await loadFiles() : [];
      if (superseded()) return "empty";
      const target = classifyAddress(v, files);
      v = target.kind === "web" ? target.url : target.kind === "search" ? searchUrl(target.query, browserSearch()) : target.path;
      // The file list can take a moment: by then the user may be typing the next address, or have
      // clicked back into the bar with it selected, where rewriting it would move the caret to
      // the end and glue the next keys onto the old address.
      if (edits.current === editsAtStart && focuses.current === focusesAtStart) setInput(v);
      if (!fromHistory) setHist((h) => pushAddress(h, v));

      if (/^https?:\/\//i.test(v)) {
        try {
          // An address that doesn't parse falls through to the plain loader below.
          new URL(v);
          // A remote project's localhost is on its machine: open it through a tunnel.
          if (isRemotePath(workspace)) v = await tunnelUrl(v, workspace).catch(() => v);
          if (superseded()) return "empty";
          // Every web address opens in the native webview, local servers too, so their CORS
          // rules, cookies and storage behave as in a normal browser.
          targetRef.current = null;
          setExtUrl(v);
          setSrc("");
          return "external";
        } catch { /* fall through to direct */ }
        setSrc(v);
        setExtUrl("");
        return "file";
      }

      setExtUrl("");
      if (!workspace) return "empty";
      const abs = /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith("/") || /^ssh:\/\//i.test(v) ? v : joinPath(workspace, v);
      // A remote file of any kind goes through the preview site: the asset protocol only reads
      // this PC's files.
      if (/\.html?$/i.test(abs) || isRemotePath(workspace)) {
        const dir = abs.replace(/[\\/][^\\/]*$/, "");
        targetRef.current = { root: dir };
        // Each folder is served on its own site, so a tab in the background keeps reaching it.
        // With the tab's cookie profile, so the page's storage follows "Keep cookies" as a website's does.
        const profile = cookieProfile(getBrowserPrefs().cookies, workspace);
        const site = await invoke<string>("agent_set_preview_root", { root: dir, profile }).catch(() => null);
        if (superseded()) return "empty";
        if (site) {
          setSrc(`${site}/${encodeURIComponent(abs.slice(dir.length + 1))}?v=${Date.now()}`);
          return "local";
        }
      }
      setSrc(convertFileSrc(abs));
      return "file";
    },
    [workspace, tabId, setMenuOpen, setExtUrl, loadFiles, onUserLoad],
  );

  const go = () => void loadTarget(input, true);
  // Inside a website its own history goes first, as in a browser (and keeps the page's state
  // where the site allows it); past its first page, the tab's history takes over, back to a
  // file or another server it showed before.
  const webBack = !!extUrl && web?.canBack === true;
  const webForward = !!extUrl && web?.canForward === true;
  const canBack = webBack || hist.i > 0;
  const canForward = webForward || hist.i < hist.list.length - 1;
  const step = (delta: number) => {
    if (delta < 0 ? webBack : webForward) {
      void goPreviewHistory(tabId, delta).catch(() => {});
      return;
    }
    const i = hist.i + delta;
    if (i < 0 || i >= hist.list.length) return;
    setHist((h) => ({ ...h, i }));
    void loadTarget(hist.list[i], true, true);
  };
  const reload = () => {
    if (extUrl) { void reloadPreviewWebview(tabId); return; }
    if (input) void loadTarget(input, manual);
    setReloadKey((k) => k + 1);
  };

  return {
    input,
    setInput: setInputFromOutside,
    src,
    setSrc,
    extUrl,
    setExtUrl,
    manual,
    setManual,
    reloadKey,
    setReloadKey,
    urlFocused,
    setUrlFocused,
    hist,
    targetRef,
    loadTarget,
    go,
    canBack,
    canForward,
    step,
    reload,
  };
}
