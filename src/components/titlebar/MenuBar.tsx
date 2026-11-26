import { useEffect, useRef, useState, type ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft, ArrowRight, BookOpen, ChevronRight, ClipboardPaste, Copy, Folder, FolderOpen, Globe, Info, Keyboard,
  LogOut, Menu, MessageCircleQuestion, MessageSquareHeart, PanelLeft, PanelRightClose, Redo2, RefreshCw, Scissors,
  ScrollText, Search, Settings, Sparkles, SquarePen, SquareTerminal, StepBack, StepForward, SunMoon, Terminal,
  TextSearch, TextSelect, Undo2,
} from "lucide-react";
import { ChangesIcon, type TitleBarView } from "@/components/TitleBar";
import { FeedbackModal } from "@/components/FeedbackModal";
import { requestUpdateCheck } from "@/lib/updateCheckRequest";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { useBindings, type ShortcutId } from "@/lib/keyBindings";
import { openExternalUrl } from "@/lib/openExternal";
import { siteUrl } from "@/lib/siteLinks";
import { useCloseOnBlur } from "@/lib/useCloseOnBlur";
import { cn } from "@/lib/utils";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** What the menus need from the app, beyond the views the title bar already opens. */
export interface MenuBarActions {
  /** Does what a changeable shortcut does (`runShortcutAction`). */
  runShortcut: (id: ShortcutId) => void;
  newTerminal: () => void;
  openFolder: () => void;
  /** Opens Settings, on a section when given. */
  openSettings: (section?: string) => void;
  whatsNew: () => void;
  goBack: () => void;
  goForward: () => void;
  /** Opens the next (1) or previous (-1) session in Recents. */
  cycleSession: (step: 1 | -1) => void;
}

interface Item {
  icon: ComponentType<{ className?: string }>;
  label: string;
  kbd?: string | null;
  run: () => void;
  disabled?: boolean;
}

/** A line between groups of items. */
type Entry = Item | null;

/** Runs on the element that has the focus: the menus never take it (see `keepFocus`). */
function edit(command: "undo" | "redo" | "cut" | "copy" | "selectAll") {
  document.execCommand(command);
}

async function paste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) document.execCommand("insertText", false, text);
  } catch {
    // No access to the clipboard: Ctrl+V still pastes.
  }
}

/** A mouse press on the menus doesn't move the focus, so Edit's commands act on the field the
 *  user was typing in. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const PANEL = "rounded-[5px] border border-bg-300 bg-bg-100 shadow-lg p-1";
const ROW = "flex items-center gap-2.5 w-full text-left px-2 py-1.5 rounded-[5px] text-[13px] transition-colors";

/** The ☰ button, as in Claude's desktop app: File, Edit, View, Go and Help, each opening its items
 *  to the side. They run the same actions as the shortcuts they show, which follow the user's own
 *  (Keyboard shortcuts). */
export function MenuBar({
  actions,
  onToggleView,
  hasMessages,
  canGoBack,
  canGoForward,
}: {
  actions: MenuBarActions;
  onToggleView: (view: TitleBarView) => void;
  /** Changes and the side chat belong to a chat that has started, as in the title bar. */
  hasMessages: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}) {
  const tr = useTranslations();
  const t = tr.menuBar;
  const keys = useBindings();
  const [open, setOpen] = useState(false);
  /** The menu whose row is lit, and whose items show beside it when `sub` is on. */
  const [top, setTop] = useState(-1);
  const [sub, setSub] = useState(false);
  /** The lit item in the open menu's items; -1 for none. */
  const [item, setItem] = useState(-1);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const shortcut = (id: ShortcutId): Item["run"] => () => actions.runShortcut(id);
  const menus: { label: string; items: Entry[] }[] = [
    {
      label: t.file,
      items: [
        { icon: SquarePen, label: t.newSession, kbd: keys.newSession, run: shortcut("newSession") },
        { icon: FolderOpen, label: t.openFolder, run: actions.openFolder },
        { icon: SquareTerminal, label: t.newTerminal, kbd: keys.newTerminal, run: actions.newTerminal },
        null,
        { icon: Search, label: t.searchSessions, kbd: keys.searchSessions, run: shortcut("searchSessions") },
        null,
        { icon: Settings, label: t.settings, kbd: keys.openSettings, run: () => actions.openSettings() },
        null,
        { icon: LogOut, label: t.quit, run: () => void (isTauri ? getCurrentWindow().close() : undefined), disabled: !isTauri },
      ],
    },
    {
      label: t.edit,
      items: [
        { icon: Undo2, label: t.undo, kbd: "Ctrl+Z", run: () => edit("undo") },
        { icon: Redo2, label: t.redo, kbd: "Ctrl+Y", run: () => edit("redo") },
        null,
        { icon: Scissors, label: t.cut, kbd: "Ctrl+X", run: () => edit("cut") },
        { icon: Copy, label: t.copy, kbd: "Ctrl+C", run: () => edit("copy") },
        { icon: ClipboardPaste, label: t.paste, kbd: "Ctrl+V", run: () => void paste() },
        { icon: TextSelect, label: t.selectAll, kbd: "Ctrl+A", run: () => edit("selectAll") },
        null,
        { icon: TextSearch, label: t.find, kbd: keys.find, run: shortcut("find") },
      ],
    },
    {
      label: t.view,
      items: [
        { icon: PanelLeft, label: t.sidebar, kbd: keys.toggleSidebar, run: shortcut("toggleSidebar") },
        { icon: Terminal, label: tr.views.terminal, kbd: keys.toggleTerminal, run: () => onToggleView("terminal") },
        { icon: ChangesIcon, label: tr.views.diff, kbd: keys.toggleDiff, run: () => onToggleView("diff"), disabled: !hasMessages },
        { icon: Globe, label: tr.titleBar.browser, kbd: keys.togglePreview, run: () => onToggleView("preview") },
        { icon: Folder, label: tr.views.files, kbd: keys.toggleFiles, run: () => onToggleView("files") },
        { icon: MessageCircleQuestion, label: tr.sideChat.title, kbd: keys.sideChat, run: () => onToggleView("sidechat"), disabled: !hasMessages },
        { icon: ScrollText, label: t.transcript, kbd: keys.transcriptView, run: shortcut("transcriptView") },
        null,
        { icon: PanelRightClose, label: t.closePanel, kbd: keys.closePanel, run: shortcut("closePanel") },
        { icon: SunMoon, label: t.toggleTheme, kbd: keys.toggleTheme, run: shortcut("toggleTheme") },
      ],
    },
    {
      label: t.go,
      items: [
        { icon: ArrowLeft, label: tr.titleBar.back, kbd: "Alt+←", run: actions.goBack, disabled: !canGoBack },
        { icon: ArrowRight, label: tr.titleBar.forward, kbd: "Alt+→", run: actions.goForward, disabled: !canGoForward },
        null,
        { icon: StepForward, label: tr.shortcutsModal.nextSession, kbd: "Ctrl+Tab", run: () => actions.cycleSession(1) },
        { icon: StepBack, label: tr.shortcutsModal.previousSession, kbd: "Ctrl+Shift+Tab", run: () => actions.cycleSession(-1) },
      ],
    },
    {
      label: t.help,
      items: [
        { icon: Keyboard, label: t.shortcuts, kbd: keys.openShortcuts, run: shortcut("openShortcuts") },
        { icon: Sparkles, label: tr.changelog.whatsNew, run: actions.whatsNew },
        { icon: BookOpen, label: t.docs, run: () => openExternalUrl(siteUrl("docs", getLanguage())) },
        { icon: MessageSquareHeart, label: t.feedback, run: () => setFeedbackOpen(true) },
        null,
        {
          icon: RefreshCw,
          label: t.checkUpdates,
          run: () => {
            requestUpdateCheck();
            actions.openSettings("acerca");
          },
        },
        { icon: Info, label: t.about, run: () => actions.openSettings("acerca") },
      ],
    },
  ];

  const close = () => {
    setOpen(false);
    setTop(-1);
    setSub(false);
    setItem(-1);
  };
  const showSub = (i: number) => {
    setTop(i);
    setSub(true);
    setItem(-1);
  };
  const choose = (it: Item) => {
    if (it.disabled) return;
    close();
    it.run();
  };
  useCloseOnBlur(open, close);

  // The keys stay where the focus is (the composer, usually): while the menu is open they're read
  // here first, so Escape closes it instead of stopping the reply.
  const state = useRef({ menus, top, sub, item, choose });
  useEffect(() => {
    state.current = { menus, top, sub, item, choose };
  });
  useEffect(() => {
    if (!open) return;
    const nextItem = (items: Entry[], from: number, dir: 1 | -1) => {
      for (let i = 1; i <= items.length; i++) {
        const at = (from + dir * i + items.length * 2) % items.length;
        const it = items[at];
        if (it && !it.disabled) return at;
      }
      return -1;
    };
    const onKey = (e: KeyboardEvent) => {
      const s = state.current;
      const items = s.top >= 0 ? s.menus[s.top].items : [];
      const inItems = s.sub && s.item >= 0;
      const n = s.menus.length;
      let handled = true;
      if (e.key === "Escape") {
        if (s.sub) {
          setSub(false);
          setItem(-1);
        } else close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (inItems) setItem(nextItem(items, s.item, dir));
        else {
          setTop(s.top < 0 ? (dir === 1 ? 0 : n - 1) : (s.top + dir + n) % n);
          setSub(false);
          setItem(-1);
        }
      } else if (e.key === "ArrowRight" || (e.key === "Enter" && !inItems)) {
        if (!inItems) {
          const at = s.top < 0 ? 0 : s.top;
          setTop(at);
          setSub(true);
          setItem(nextItem(s.menus[at].items, -1, 1));
        } else handled = e.key === "Enter";
      } else if (e.key === "ArrowLeft") {
        if (s.sub) {
          setSub(false);
          setItem(-1);
        }
      } else if (e.key === "Enter") {
        const it = items[s.item];
        if (it) s.choose(it);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          aria-label={tr.titleBar.menu}
          aria-haspopup="menu"
          aria-expanded={open}
          data-tooltip={open ? undefined : tr.titleBar.menu}
          onMouseDown={keepFocus}
          onClick={() => (open ? close() : setOpen(true))}
          className={cn(
            "inline-flex items-center justify-center w-8 h-7 rounded-md transition-colors",
            open ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100 hover:bg-bg-200",
          )}
        >
          <Menu className="w-4 h-4" />
        </button>
        {open && (
          <div data-mod-menu role="menu" aria-label={tr.titleBar.menu} data-webview-hole className={cn("absolute left-0 top-full mt-1 z-[70] w-48", PANEL)}>
            {menus.map((m, i) => (
              <div key={m.label} className="relative" onMouseEnter={() => showSub(i)}>
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={sub && top === i}
                  onMouseDown={keepFocus}
                  onClick={() => showSub(i)}
                  className={cn(ROW, "text-text-100", top === i && "bg-bg-200")}
                >
                  <span className="flex-1 truncate">{m.label}</span>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-text-400" />
                </button>
                {sub && top === i && (
                  <div
                    data-mod-menu
                    role="menu"
                    aria-label={m.label}
                    data-webview-hole
                    onMouseLeave={() => setItem(-1)}
                    className={cn("absolute left-full -top-1 ml-1.5 w-64", PANEL)}
                  >
                    {m.items.map((it, j) =>
                      it === null ? (
                        <div key={j} className="my-1 mx-1 border-t border-bg-300" />
                      ) : (
                        <button
                          key={j}
                          type="button"
                          role="menuitem"
                          aria-disabled={it.disabled || undefined}
                          onMouseDown={keepFocus}
                          onMouseEnter={() => setItem(it.disabled ? -1 : j)}
                          onClick={() => choose(it)}
                          className={cn(
                            ROW,
                            it.disabled ? "text-text-500 cursor-default" : "text-text-100",
                            item === j && "bg-bg-200",
                          )}
                        >
                          <it.icon className={cn("w-4 h-4 shrink-0", it.disabled ? "text-text-500" : "text-text-300")} />
                          <span className="flex-1 truncate">{it.label}</span>
                          {it.kbd && <span className="shrink-0 text-[11px] text-text-500">{it.kbd}</span>}
                        </button>
                      ),
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}
