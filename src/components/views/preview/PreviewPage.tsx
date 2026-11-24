import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, MoreVertical, Globe, Maximize2, Minimize2 } from "lucide-react";
import { invoke } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { PREVIEW_ORIGIN, previewSite } from "@/lib/previewWebview";
import { useTranslations } from "@/lib/i18n";
import { VIEWPORT_SIZES, cookieProfile, useBrowserPrefs } from "@/lib/browserPrefs";
import { AnnotationBar } from "../AnnotationBar";
import { pageLabel, type PageSnapshot, type PreviewProps } from "./helpers";
import { useDefaultBrowserName } from "./useDefaultBrowserName";
import { useBrowserMenu } from "./useBrowserMenu";
import { usePageAddress } from "./usePageAddress";
import { useDevServers } from "./useDevServers";
import { usePageIcon } from "./usePageIcon";
import { usePageShortcuts } from "./usePageShortcuts";
import { useWebviewVisibility, useNativeWebview } from "./useNativeWebview";
import { usePreviewController } from "./usePreviewController";
import { usePickAndAnnotate } from "./usePickAndAnnotate";
import { ServersMenu } from "./ServersMenu";
import { DevServerLogs } from "./DevServerLogs";
import { CookieImportDialog } from "./CookieImportDialog";
import { AddressBar } from "./AddressBar";
import { BrowserMenu } from "./BrowserMenu";
import { PageEmptyState } from "./PageEmptyState";
import { BookmarksBar } from "./BookmarksBar";
import { addBookmark, isBookmarked, removeBookmark, useBookmarks } from "@/lib/browserBookmarks";
import { browserSearch } from "@/lib/featureSettings";
import { searchUrl } from "@/lib/searchEngines";
import { useAddressSuggestions } from "./useAddressSuggestions";
import type { AddressSuggestion } from "./addressSuggestions";

/** What a local page may do: all a page of the user's project needs (scripts, forms, dialogs,
 *  popups, downloads, and its own origin for storage, cookies and module scripts) but navigating
 *  the app's window, which would make it run as the app. Its own origin is safe to keep: the
 *  preview host isn't the app's origin, so the page still can't reach the app or lift its sandbox. */
const PAGE_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation";

/** Chromium refuses to show a PDF in a sandboxed frame; its viewer runs none of the file's code. */
const isPdf = (src: string) => /\.pdf(?:[?#]|$)/i.test(src);

/** One browser tab of the preview: its own address, history and page. */
export function PreviewPage({
  workspace,
  requestedFile,
  onRequestDevServer,
  onAddServer,
  onClose,
  onToggleMaximize,
  maximized,
  onPickElement,
  onAttachImage,
  slot,
  onUserLoad,
  front,
  active,
  fresh,
  strip,
  tabId,
  onLabel,
  onIcon,
  restored,
  onSnapshot,
}: PreviewProps & {
  /** The browser (one per chat) the tab belongs to. */
  slot: string;
  /** The user opened an address in the tab. */
  onUserLoad: (tabId: string) => void;
  /** The tab in front of its browser, whether or not the browser is on screen. */
  front: boolean;
  active: boolean;
  /** Opened with "+": starts blank instead of jumping to a running dev server. */
  fresh: boolean;
  strip: ReactNode;
  tabId: string;
  onLabel: (tabId: string, label: string) => void;
  /** The page's icon (a data URL or an address), or "" for none. */
  onIcon: (tabId: string, icon: string) => void;
  /** What the tab showed before the app's page reloaded. */
  restored?: PageSnapshot;
  onSnapshot: (tabId: string, snap: PageSnapshot) => void;
}) {
  const t = useTranslations().views;
  const tOwn = useTranslations().previewTexts;
  const { menuOpen, setMenuOpen, menuRef, menuButtonRef, sub, setSub, subLeft, openSub, toggleMenu, notice, notify } = useBrowserMenu();
  const {
    input,
    setInput,
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
  } = usePageAddress({ workspace, tabId, fresh, restored, setMenuOpen, onUserLoad });
  const [extError, setExtError] = useState("");
  // Until the restored address is back, an empty one must not close the page waiting for it.
  const awaitingRestore = useRef(!!restored?.input);
  const {
    launch,
    launching,
    launchError,
    serversOpen,
    setServersOpen,
    serversRef,
    runningShellOf,
    isUp,
    canStop,
    stopServer,
    stopping,
    stopConfirm,
    startLaunch,
    startSavedServer,
    hasDevScript,
    config,
    starting,
    boot,
    cancelBoot,
    prep,
    answerPrep,
  } = useDevServers({ workspace, slot, requestedFile, manual, input, setInput, setSrc, setExtUrl, targetRef, loadTarget });
  // The address bar's suggestions: what was typed and what the search engine suggests.
  const suggest = useAddressSuggestions({ input, focused: urlFocused });
  const pickSuggestion = (s: AddressSuggestion) => {
    suggest.close();
    // A search row always searches, even when the words also name a file.
    void loadTarget(s.kind === "address" ? s.value : searchUrl(s.value, browserSearch()), true);
  };
  const prefs = useBrowserPrefs();
  const browserName = useDefaultBrowserName();
  const [picking, setPicking] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { onLabel(tabId, pageLabel(input)); }, [tabId, input, onLabel]);

  usePageIcon({ tabId, src, extUrl, active, iframeRef, onIcon });
  usePageShortcuts(tabId, iframeRef);

  // Bookmarks: the star saves the page shown (its title and icon, as the website reports them),
  // and the bar under the address opens a saved one in this tab.
  const bookmarks = useBookmarks();
  const pageUrl = hist.list[hist.i] ?? input;
  const bookmarked = !!pageUrl && isBookmarked(bookmarks, pageUrl);
  const toggleBookmark = async () => {
    if (!pageUrl) return;
    if (bookmarked) {
      removeBookmark(pageUrl);
      return;
    }
    const site = extUrl ? await invoke<{ url: string; title: string; icon: string | null } | null>("preview_agent_status", { tab: tabId }).catch(() => null) : null;
    addBookmark({ url: site?.url || pageUrl, title: site?.title?.trim() || pageLabel(pageUrl), icon: site?.icon ?? "" });
  };

  // Back on the page it showed before a reload. The native page under this tab is still open
  // at that address, so it is shown again as it was instead of loading anew.
  const restoredInput = useRef(restored?.input);
  useEffect(() => {
    const v = restoredInput.current;
    restoredInput.current = undefined;
    if (v) {
      void Promise.resolve()
        .then(() => loadTarget(v, !!restored?.manual, true))
        .finally(() => { awaitingRestore.current = false; });
    }
  }, [loadTarget, restored]);
  useEffect(() => { onSnapshot(tabId, { input, hist, manual }); }, [tabId, input, hist, manual, onSnapshot]);

  const [pickTip, setPickTip] = useState(false);
  // Hidden while picking, so it never covers the element being chosen.
  const pickTipShown = pickTip && !picking && (!!src || !!extUrl);
  // The annotation toolbar, over pages the picker can reach (left out of screenshots).
  const annotating = picking && (src.startsWith(PREVIEW_ORIGIN) || (!!extUrl && !extError));
  const barShown = annotating && !capturing;
  const { contentBounds, overlayOpen, webviewHidden } = useWebviewVisibility({
    tabId,
    active,
    extUrl,
    contentRef,
    rootRef,
    // The suggestions list hangs over the page like a menu.
    menuOpen: menuOpen || suggest.open,
    serversOpen,
    pickTipShown,
    barShown,
    setMenuOpen,
    setServersOpen,
  });
  const profile = cookieProfile(prefs.cookies, workspace);
  // A local page's site goes with the cookie profile (a website gets a new webview instead), so
  // a change of "Keep cookies" opens it again on the new one.
  const shownProfile = useRef(profile);
  useEffect(() => {
    if (shownProfile.current === profile) return;
    shownProfile.current = profile;
    if (previewSite(src) && input) void loadTarget(input, manual, true);
  }, [profile, src, input, manual, loadTarget]);

  usePreviewController({ slot, tabId, front, active, src, extUrl, input, loadTarget, setManual, setReloadKey, targetRef, iframeRef, contentBounds });

  const extErrorKey = `${extUrl}|${webviewHidden}`;
  const [lastExtErrorKey, setLastExtErrorKey] = useState(extErrorKey);
  if (extErrorKey !== lastExtErrorKey) {
    setLastExtErrorKey(extErrorKey);
    setExtError("");
  }

  const frozen = useNativeWebview({
    tabId,
    active,
    extUrl,
    webviewHidden,
    overlayOpen,
    contentBounds,
    contentRef,
    profile,
    awaitingRestore,
    setExtError,
  });

  const proxied = src.startsWith(PREVIEW_ORIGIN);
  const pickable = proxied || (!!extUrl && !extError);
  const pickError = !pickable;
  const hasPage = !!src || !!extUrl;

  const { annTool, chooseTool, pickArmed, togglePicker, annShape, setAnnShape, annColor, setAnnColor, annWidth, setAnnWidth, annState, annotRun, addAnnotatedShot } =
    usePickAndAnnotate({
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
    });

  // The dev server whose output the logs panel shows: the one Nyxs started on the page's port,
  // or else the last one it started.
  const [logsOpen, setLogsOpen] = useState(false);
  const [importingCookies, setImportingCookies] = useState(false);
  const pagePort = Number(/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i.exec(input.trim())?.[1]) || null;
  const logsSource = (() => {
    const running = launch.flatMap((e) => {
      const shell = runningShellOf(e);
      return shell ? [{ entry: e, shell }] : [];
    });
    if (!running.length) return null;
    const pick = running.find((r) => pagePort && r.entry.port === pagePort) ?? running.reduce((a, b) => ((b.shell.startedAt ?? 0) > (a.shell.startedAt ?? 0) ? b : a));
    const port = pick.entry.port;
    return { shellId: pick.shell.id, title: port ? `${pick.entry.name} · localhost:${port}` : pick.entry.name };
  })();

  const openInLabel = t.openInNamed.replace("{name}", browserName ?? t.browserFallback);
  const vpSize = prefs.viewport === "responsive" ? null : VIEWPORT_SIZES[prefs.viewport];

  if (!workspace) {
    return <div className="flex items-center justify-center h-full text-sm text-text-400">{t.noWorkingFolder}</div>;
  }

  return (
    <div ref={rootRef} className="flex flex-col h-full">
      {stopConfirm}
      <div className="relative border-b border-bg-300">
        <div className="flex items-center gap-1 px-2 pt-1.5">
          <div className="min-w-0 flex-1">{strip}</div>
          {(launch.length > 0 || onAddServer) && (
            <ServersMenu
              launch={launch}
              launching={launching}
              launchError={launchError}
              serversOpen={serversOpen}
              setServersOpen={setServersOpen}
              serversRef={serversRef}
              runningShellOf={runningShellOf}
              isUp={isUp}
              canStop={canStop}
              stopServer={stopServer}
              stopping={stopping}
              startLaunch={startLaunch}
              boot={boot}
              cancelBoot={cancelBoot}
              prep={prep}
              answerPrep={answerPrep}
              workspace={workspace}
              onAddServer={onAddServer}
              logs={logsSource ? { open: logsOpen, toggle: () => setLogsOpen((o) => !o) } : undefined}
            />
          )}
          <button
            ref={menuButtonRef}
            type="button"
            onClick={toggleMenu}
            aria-label={t.browserSettings}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-tooltip={menuOpen ? undefined : t.browserSettings}
            className={cn("p-1 rounded hover:bg-bg-200 shrink-0", menuOpen ? "bg-bg-200 text-text-100" : "text-text-400 hover:text-text-100")}
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
          {onToggleMaximize && (
            <button type="button" onClick={onToggleMaximize} aria-label={maximized ? t.showChat : t.diffExpandPanel} data-tooltip={maximized ? t.showChat : t.diffExpandPanel} className="p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-200 shrink-0">
              {maximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
          <button type="button" onClick={onClose} aria-label={t.close} data-tooltip={t.close} className="p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-200 shrink-0">
            <X className="w-4 h-4" />
          </button>

        </div>
        <AddressBar
          canBack={canBack}
          canForward={canForward}
          step={step}
          reload={reload}
          input={input}
          setInput={setInput}
          urlFocused={urlFocused}
          setUrlFocused={setUrlFocused}
          go={go}
          hist={hist}
          notice={notice}
          picking={picking && pickArmed}
          onTogglePick={togglePicker}
          hasPage={hasPage}
          pickTipShown={pickTipShown}
          setPickTip={setPickTip}
          bookmarked={bookmarked}
          onToggleBookmark={() => void toggleBookmark()}
          suggest={suggest}
          onPick={pickSuggestion}
        />
        <BookmarksBar bookmarks={bookmarks} onOpen={(url) => void loadTarget(url, true)} />
        {menuOpen && (
          <BrowserMenu
            menuRef={menuRef}
            sub={sub}
            setSub={setSub}
            subLeft={subLeft}
            openSub={openSub}
            setMenuOpen={setMenuOpen}
            notify={notify}
            workspace={workspace}
            input={input}
            extUrl={extUrl}
            tabId={tabId}
            hasPage={hasPage}
            openInLabel={openInLabel}
            contentBounds={contentBounds}
            loadTarget={loadTarget}
            reload={reload}
            onImportCookies={() => setImportingCookies(true)}
          />
        )}
        {importingCookies && (
          <CookieImportDialog profile={profile} onClose={() => setImportingCookies(false)} onReload={hasPage ? reload : undefined} />
        )}
      </div>
      {picking && hasPage && pickError && (
        <div className="px-3 py-1.5 text-[11.5px] text-yellow-400/90 bg-yellow-400/10 border-b border-bg-300">
          {t.inspectFailed}
        </div>
      )}
      <div className={cn("relative flex-1 min-h-0 flex", vpSize &&"items-center justify-center overflow-hidden bg-bg-200 p-3")}>
      <div
        ref={contentRef}
        className={cn("bg-white", vpSize ? "shadow-sm ring-1 ring-bg-300" : "flex-1")}
        style={vpSize ? { width: vpSize.width, height: vpSize.height, maxWidth: "100%", maxHeight: "100%" } : undefined}
      >
        {extUrl ? (
          extError ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6 bg-bg-100 gap-3">
              <Globe className="w-7 h-7 text-text-500" />
              <p className="text-sm text-text-300">{tOwn.openFailed}</p>
              <pre className="max-w-full overflow-auto text-[11px] font-mono text-red-400/90 whitespace-pre-wrap">{extError}</pre>
              <button
                onClick={() => invoke("agent_open_external", { url: extUrl }).catch(() => {})}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-0 hover:bg-accent-hover transition-colors"
              >
                <Globe className="w-3.5 h-3.5" /> {openInLabel}
              </button>
            </div>
          ) : (
            <div className="relative w-full h-full bg-bg-100 overflow-hidden">
              {frozen && frozen.url === extUrl && webviewHidden && (
                <img
                  src={frozen.src}
                  alt=""
                  draggable={false}
                  className="absolute top-0 pointer-events-none select-none"
                  style={{ left: frozen.left, width: frozen.width, height: frozen.height }}
                />
              )}
            </div>
          )
        ) : src ? (
          // A frame's sandbox only changes with a new frame: a PDF gets one of its own.
          <iframe ref={iframeRef} key={`u${reloadKey}${isPdf(src) ? "pdf" : ""}`} sandbox={isPdf(src) ? undefined : PAGE_SANDBOX} src={src} title="preview" onLoad={() => setLoaded((n) => n + 1)} className="w-full h-full border-0" />
        ) : (
          <PageEmptyState
            launch={launch}
            launching={launching}
            launchError={launchError}
            runningShellOf={runningShellOf}
            isUp={isUp}
            canStop={canStop}
            stopServer={stopServer}
            stopping={stopping}
            startLaunch={startLaunch}
            config={config}
            starting={starting}
            startSavedServer={startSavedServer}
            boot={boot}
            cancelBoot={cancelBoot}
            prep={prep}
            answerPrep={answerPrep}
            workspace={workspace}
            hasDevScript={hasDevScript}
            onRequestDevServer={onRequestDevServer}
          />
        )}
      </div>
      {barShown && (
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
      </div>
      {/* Under the page, which shrinks for it (the native page follows its box). */}
      {logsOpen && logsSource && <DevServerLogs key={logsSource.shellId} shellId={logsSource.shellId} title={logsSource.title} onClose={() => setLogsOpen(false)} />}
    </div>
  );
}
