import { useEffect, useRef, useState, type ComponentType } from "react";
import { Menu, PanelLeft, Search, ArrowLeft, ArrowRight, Minus, Square, X, Terminal, Globe, Folder, MoreVertical, Diamond, ListChecks, Bot, Clapperboard, MessageCircleQuestion } from "lucide-react";
import { MusicPlayerBar } from "@/components/music/MusicPlayerBar";
import { ACTIVE_TOGGLE } from "@/lib/uiClasses";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@/lib/ipc";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The views the title bar opens: its own buttons, in the order shown, then the ⋮ menu. */
export type TitleBarView = "terminal" | "diff" | "preview" | "files" | "background" | "plan" | "fleet" | "video" | "sidechat";

/** Changes: a square with a plus over a minus. */
function ChangesIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className={className} aria-hidden>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M8 4.8v4M6 6.8h4M6 11h4" />
    </svg>
  );
}


const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const appWindow = isTauri ? getCurrentWindow() : null;
/** macOS draws its own close/minimise/full-screen buttons over the title bar (see
 *  tauri.macos.conf.json), so the bar leaves room for them instead of drawing its own. */
const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

export function TitleBar({
  onToggleSidebar,
  onSearch,
  onMenu,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  minimal = false,
  onWhatsNew,
  onToggleView,
  onPrepareView,
  openViews = [],
  showChanges = false,
}: {
  onToggleSidebar?: () => void;
  onSearch?: () => void;
  onMenu?: () => void;
  onBack?: () => void;
  onForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  minimal?: boolean;
  onWhatsNew?: () => void;
  onToggleView?: (view: TitleBarView) => void;
  /** The pointer or focus is on a view's button: a slow view can start loading before the click. */
  onPrepareView?: (view: TitleBarView) => void;
  /** The views showing in the side panel, so their buttons read as on. */
  openViews?: string[];
  /** The Changes button, and background tasks, plan and the side chat in the ⋮ menu, only appear
   *  once the chat has messages. */
  showChanges?: boolean;
}) {
  const t = useTranslations().titleBar;
  const tViews = useTranslations().views;
  const tChangelog = useTranslations().changelog;
  const tVideo = useTranslations().videoPanel;
  const tSide = useTranslations().sideChat;
  const viewButtons: { id: TitleBarView; icon: ComponentType<{ className?: string }>; label: string; kbd: string }[] = [
    { id: "terminal", icon: Terminal, label: tViews.terminal, kbd: "Ctrl+`" },
    ...(showChanges ? [{ id: "diff" as const, icon: ChangesIcon, label: tViews.diff, kbd: "Ctrl+Shift+D" }] : []),
    { id: "preview", icon: Globe, label: t.browser, kbd: "Ctrl+Shift+B" },
    { id: "files", icon: Folder, label: tViews.files, kbd: "Ctrl+Shift+F" },
  ];
  // Background tasks and the plan belong to a chat that has started; agents are always there.
  const menuViews: { id: TitleBarView; icon: ComponentType<{ className?: string }>; label: string }[] = [
    ...(showChanges
      ? [
          { id: "background" as const, icon: Diamond, label: tViews.backgroundTasks },
          { id: "plan" as const, icon: ListChecks, label: tViews.plan },
        ]
      : []),
    { id: "fleet", icon: Bot, label: tViews.agentsView },
    { id: "video", icon: Clapperboard, label: tVideo.title },
    // It reads the chat's messages: nothing to ask about before there are any.
    ...(showChanges ? [{ id: "sidechat" as const, icon: MessageCircleQuestion, label: tSide.title }] : []),
  ];
  const [optionsOpen, setOptionsOpen] = useState(false);
  // In full screen macOS hides its window buttons, so their room goes back to the bar.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!isMac || !appWindow) return;
    let alive = true;
    const check = () => void appWindow.isFullscreen().then((on) => { if (alive) setFullscreen(on); }, () => {});
    check();
    const unlisten = appWindow.onResized(check);
    return () => { alive = false; void unlisten.then((off) => off()); };
  }, []);
  // Keep-awake lives in the backend for as long as the app runs; read it each time the menu opens.
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (!optionsOpen || !isTauri) return;
    let alive = true;
    void invoke<boolean>("keep_awake_get").then((on) => { if (alive) setAwake(on); }, () => {});
    return () => { alive = false; };
  }, [optionsOpen]);
  const toggleAwake = () => {
    const next = !awake;
    setAwake(next);
    if (!isTauri) return;
    invoke<boolean>("keep_awake_set", { on: next }).then(setAwake, () => setAwake(!next));
  };
  const optionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!optionsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!optionsRef.current?.contains(e.target as Node)) setOptionsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOptionsOpen(false); };
    // A click on a page open in the built-in browser goes to its native webview, not to this
    // document: the app only sees its window lose focus.
    const onBlur = () => setOptionsOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [optionsOpen]);
  const buttons = [
    { id: "menu", icon: Menu, label: t.menu, onClick: onMenu, disabled: false },
    { id: "panel", icon: PanelLeft, label: t.togglePanel, onClick: onToggleSidebar, disabled: false },
    { id: "search", icon: Search, label: t.search, onClick: onSearch, disabled: false },
    { id: "back", icon: ArrowLeft, label: t.back, onClick: onBack, disabled: !canGoBack, kbd: "Alt+Left" },
    { id: "forward", icon: ArrowRight, label: t.forward, onClick: onForward, disabled: !canGoForward, kbd: "Alt+Right" },
  ];

  return (
    <div
      data-tauri-drag-region
      data-mod-panel
      // No padding on the right where the window buttons are: the close button reaches the edge,
      // as Windows' own does.
      className={cn("relative z-[60] flex items-center justify-between h-9 shrink-0 pl-2 select-none bg-bg-0", isMac ? "pr-2" : "pr-0", isMac && appWindow && !fullscreen && "pl-[78px]")}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        {!minimal && buttons.map((b) => (
          <button
            key={b.id}
            type="button"
            data-tooltip={b.label}
            data-tooltip-kbd={"kbd" in b ? b.kbd : undefined}
            aria-label={b.label}
            aria-keyshortcuts={"kbd" in b ? b.kbd : undefined}
            onClick={b.onClick}
            disabled={b.disabled}
            // In a narrow window (Nyxs beside the agent using the computer) the history arrows
            // give way first, so the bar never runs wider than the window.
            className={`inline-flex items-center justify-center w-8 h-7 rounded-md transition-colors ${
              b.id === "back" || b.id === "forward" ? "max-[559px]:hidden" : ""
            } ${
              b.disabled
                ? "text-text-500 opacity-40 cursor-default"
                : "text-text-300 hover:text-text-100 hover:bg-bg-200"
            }`}
          >
            <b.icon className="w-4 h-4" />
          </button>
        ))}
      </div>

      {!minimal && <MusicPlayerBar />}

      <div className="flex items-center gap-0.5">
        {/* Only on a session with no messages yet: once it has started, the bar stays quiet. */}
        {!minimal && onWhatsNew && !showChanges && (
          <button
            type="button"
            onClick={onWhatsNew}
            className="inline-flex items-center h-7 px-2 mr-1 rounded-md text-[13px] text-[color:var(--link)] hover:bg-bg-200 transition-colors max-[639px]:hidden"
          >
            {tChangelog.whatsNew}
          </button>
        )}
        {!minimal && onToggleView && viewButtons.map((b) => (
          <button
            key={b.id}
            type="button"
            data-tooltip={b.label}
            data-tooltip-kbd={b.kbd}
            aria-label={b.label}
            aria-keyshortcuts={b.kbd}
            aria-pressed={openViews.includes(b.id)}
            onClick={() => onToggleView(b.id)}
            onMouseEnter={() => { if (!openViews.includes(b.id)) onPrepareView?.(b.id); }}
            onFocus={() => { if (!openViews.includes(b.id)) onPrepareView?.(b.id); }}
            className={cn(
              "inline-flex items-center justify-center w-8 h-7 rounded-md transition-colors",
              openViews.includes(b.id) ? ACTIVE_TOGGLE : "text-text-300 hover:text-text-100 hover:bg-bg-200",
            )}
          >
            <b.icon className="w-4 h-4" />
          </button>
        ))}
        {!minimal && onToggleView && (
          <div ref={optionsRef} className="relative">
            <button
              type="button"
              onClick={() => setOptionsOpen((o) => !o)}
              aria-label={t.viewOptions}
              aria-haspopup="menu"
              aria-expanded={optionsOpen}
              data-tooltip={optionsOpen ? undefined : t.viewOptions}
              className={cn(
                "inline-flex items-center justify-center w-8 h-7 rounded-md transition-colors",
                menuViews.some((v) => openViews.includes(v.id))
                  ? ACTIVE_TOGGLE
                  : optionsOpen
                    ? "bg-bg-200 text-text-100"
                    : "text-text-300 hover:text-text-100 hover:bg-bg-200",
              )}
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {optionsOpen && (
              <div role="menu" aria-label={t.viewOptions} data-webview-hole className="absolute right-0 top-full mt-1 z-[70] w-60 rounded-[5px] border border-bg-300 bg-bg-100 shadow-lg p-1">
                {menuViews.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    role="menuitem"
                    onClick={() => { setOptionsOpen(false); onToggleView(v.id); }}
                    className={cn(
                      "flex items-center gap-2.5 w-full text-left px-2 py-1 rounded-[5px] text-[13px] transition-colors hover:bg-bg-200",
                      openViews.includes(v.id) ? "text-text-100 bg-bg-200" : "text-text-100",
                    )}
                  >
                    <v.icon className="w-4 h-4 shrink-0 text-text-300" />
                    <span className="truncate">{v.label}</span>
                  </button>
                ))}
                <div className="my-1 mx-1 border-t border-bg-300" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={awake}
                  onClick={toggleAwake}
                  className="flex items-center gap-3 w-full text-left px-2 py-1 rounded-[5px] transition-colors hover:bg-bg-200"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-text-100">{t.keepAwake}</span>
                    <span className="block truncate text-[11.5px] text-text-400">{t.keepAwakeHint}</span>
                  </span>
                  <span aria-hidden className={cn("relative w-8 h-[18px] shrink-0 rounded-full transition-colors", awake ? "bg-accent" : "bg-bg-300")}>
                    <span className={cn("absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform", awake && "translate-x-3.5")} />
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
        {appWindow && !isMac && (
        <div className="flex items-center ml-2">
          <button
            type="button"
            aria-label={t.minimize}
            onClick={() => appWindow.minimize()}
            className="inline-flex items-center justify-center w-11 h-9 rounded-none text-text-300 hover:text-text-100 hover:bg-bg-200 transition-colors"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            type="button"
            aria-label={t.maximize}
            onClick={() => appWindow.toggleMaximize()}
            className="inline-flex items-center justify-center w-11 h-9 rounded-none text-text-300 hover:text-text-100 hover:bg-bg-200 transition-colors"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label={t.close}
            onClick={() => appWindow.close()}
            className="inline-flex items-center justify-center w-11 h-9 rounded-none text-text-300 hover:text-white hover:bg-red-600 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

export default TitleBar;
