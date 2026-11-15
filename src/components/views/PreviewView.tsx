import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { X, Globe, Plus } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { loadReloadState, reloadStateEntries, saveReloadState } from "@/lib/reloadState";
import { previewTabsOf, registerPreviewBrowser } from "@/lib/previewControl";
import { pickAgentTab } from "@/lib/previewTabs";
import { useTranslations } from "@/lib/i18n";
import type { PageSnapshot, PreviewProps } from "./preview/helpers";
import { PreviewPage } from "./preview/PreviewPage";

interface BrowserTab {
  id: string;
  fresh: boolean;
  /** The agent opened it or started using it empty. Its next pages can go here; a tab of the
   *  user's keeps what it shows. */
  agent?: boolean;
}

interface SavedBrowser {
  tabs: BrowserTab[];
  activeId: string;
  pages: Record<string, PageSnapshot>;
}

const browserKey = (persistKey: string) => `browser:${persistKey}`;

// Tab ids restored after a reload are reused (their native pages are still open under them),
// so new ones have to start past them.
let tabSeq = Math.max(
  0,
  ...reloadStateEntries<SavedBrowser>("browser:").flatMap(([, s]) => s.tabs.map((tab) => Number(/^tab-(\d+)$/.exec(tab.id)?.[1]) || 0)),
);
const newTabId = () => `tab-${++tabSeq}`;

/** The tab for a page asked for from the chat: one that isn't the agent's, or a new one. */
const tabForRequest = (file: string, slot: string, workspace: string | null) =>
  pickAgentTab(file, previewTabsOf(slot).filter((tab) => !tab.agent), workspace) ?? newTabId();

/** Offers the browser's tabs to the agent's tools (previewControl), which act from outside React's
 *  render. Returns what makes a tab the user's: opening an address in it, whoever opened it. */
function useAgentTabs(
  slot: string,
  tabs: BrowserTab[],
  workspace: string | null,
  setTabs: Dispatch<SetStateAction<BrowserTab[]>>,
  setActiveId: (id: string) => void,
) {
  const live = useRef({ tabs, workspace });
  useLayoutEffect(() => { live.current = { tabs, workspace }; });
  const markAgentTab = useCallback((id: string, agent: boolean) => {
    setTabs((list) => (list.some((tab) => tab.id === id && !!tab.agent !== agent) ? list.map((tab) => (tab.id === id ? { ...tab, agent } : tab)) : list));
  }, [setTabs]);
  useEffect(
    () =>
      registerPreviewBrowser(slot, {
        workspace: () => live.current.workspace,
        isAgentTab: (id) => live.current.tabs.some((tab) => tab.id === id && !!tab.agent),
        openAgentTab: () => {
          const id = newTabId();
          setTabs((list) => [...list, { id, fresh: true, agent: true }]);
          setActiveId(id);
          return id;
        },
        claimTab: (id) => markAgentTab(id, true),
        focusTab: setActiveId,
      }),
    [slot, markAgentTab, setTabs, setActiveId],
  );
  return useCallback((id: string) => markAgentTab(id, false), [markAgentTab]);
}

/** A tab's page icon, or the globe while there is none or it doesn't load. */
function TabIcon({ src }: { src?: string }) {
  const [failed, setFailed] = useState("");
  if (!src || failed === src) return <Globe className="w-3.5 h-3.5 shrink-0 text-text-400" />;
  return <img src={src} alt="" draggable={false} onError={() => setFailed(src)} className="w-3.5 h-3.5 shrink-0 object-contain" />;
}

/** The preview as a small browser: several tabs, Ctrl+T for a new one. */
export function PreviewView({ persistKey, ...props }: PreviewProps & { persistKey?: string }) {
  const t = useTranslations().views;
  const [restored] = useState(() => {
    const saved = persistKey ? loadReloadState<SavedBrowser>(browserKey(persistKey)) : null;
    return saved?.tabs.length ? saved : null;
  });
  const [tabs, setTabs] = useState<BrowserTab[]>(() => restored?.tabs ?? [{ id: newTabId(), fresh: false }]);
  const [activeId, setActiveId] = useState(() => (restored && tabs.some((tab) => tab.id === restored.activeId) ? restored.activeId : tabs[0].id));
  const [labels, setLabels] = useState<Record<string, string>>({});
  const visible = props.visible !== false;
  const slot = persistKey ?? "";

  // A page asked for from the chat (a link, the Preview tool) goes where it doesn't replace what
  // another tab shows, the agent's work included. Each tab keeps its request, or it would close a
  // local page once the next request went elsewhere (see useDevServers). After a reload the tabs
  // come back on their own pages, so the last request isn't replayed into one.
  const [routed, setRouted] = useState<{ file?: string; byTab: Record<string, string | undefined> }>(() => ({
    file: props.requestedFile,
    byTab: restored ? {} : { [activeId]: props.requestedFile },
  }));

  const pages = useRef<Record<string, PageSnapshot>>(restored?.pages ?? {});
  const persist = useCallback(() => {
    if (!persistKey) return;
    const live = new Set(tabs.map((tab) => tab.id));
    pages.current = Object.fromEntries(Object.entries(pages.current).filter(([id]) => live.has(id)));
    saveReloadState(browserKey(persistKey), { tabs, activeId, pages: pages.current } satisfies SavedBrowser);
  }, [persistKey, tabs, activeId]);
  useEffect(persist, [persist]);
  const onSnapshot = useCallback((id: string, snap: PageSnapshot) => {
    pages.current = { ...pages.current, [id]: snap };
    persist();
  }, [persist]);

  // The native pages of restored tabs are waiting, hidden, to be picked up again; any tab no
  // view claims soon after a reload is closed.
  useEffect(() => {
    if (restored) void invoke("preview_claim", { tabs: restored.tabs.map((tab) => tab.id) }).catch(() => undefined);
  }, [restored]);

  const newTab = useCallback(() => {
    const id = newTabId();
    setTabs((list) => [...list, { id, fresh: true }]);
    setActiveId(id);
  }, []);

  // A site's target="_blank" link or window.open (see on_new_window in preview_webview.rs)
  // opens in a new tab right after the one it came from, in front, as in a browser.
  const tabsRef = useRef(tabs);
  useLayoutEffect(() => { tabsRef.current = tabs; });
  useEffect(() => {
    let gone = false;
    let unlisten: (() => void) | undefined;
    void listen<{ tab: string; url: string }>("preview-new-tab", ({ payload }) => {
      if (!tabsRef.current.some((tab) => tab.id === payload.tab)) return;
      const id = newTabId();
      setTabs((list) => {
        const at = list.findIndex((tab) => tab.id === payload.tab) + 1;
        return [...list.slice(0, at), { id, fresh: true }, ...list.slice(at)];
      });
      setActiveId(id);
      setRouted((r) => ({ ...r, byTab: { ...r.byTab, [id]: payload.url } }));
    }).then((stop) => {
      if (gone) stop();
      else unlisten = stop;
    });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  const closeTab = (id: string) => {
    const i = tabs.findIndex((tab) => tab.id === id);
    const rest = tabs.filter((tab) => tab.id !== id);
    if (rest.length === 0) {
      const fresh = { id: newTabId(), fresh: true };
      setTabs([fresh]);
      setActiveId(fresh.id);
      return;
    }
    setTabs(rest);
    if (id === activeId) setActiveId(rest[Math.max(0, i - 1)].id);
  };

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        newTab();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, newTab]);

  const setLabel = useCallback((id: string, label: string) => {
    setLabels((prev) => (prev[id] === label ? prev : { ...prev, [id]: label }));
  }, []);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const setIcon = useCallback((id: string, icon: string) => {
    setIcons((prev) => (prev[id] === icon ? prev : { ...prev, [id]: icon }));
  }, []);
  const onUserLoad = useAgentTabs(slot, tabs, props.workspace, setTabs, setActiveId);

  if (props.requestedFile !== routed.file) {
    const tab = props.requestedFile ? tabForRequest(props.requestedFile, slot, props.workspace) : activeId;
    setTabs((list) => (list.some((t) => t.id === tab) ? list : [...list, { id: tab, fresh: true }]));
    setActiveId(tab);
    setRouted({ file: props.requestedFile, byTab: { ...routed.byTab, [tab]: props.requestedFile } });
  }

  const strip = (
    <div className="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar">
      {tabs.map((tab) => {
        const on = tab.id === activeId;
        const label = labels[tab.id] || t.newTab;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={on}
            onClick={() => setActiveId(tab.id)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}
            className={cn(
              "group flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-md text-[12.5px] max-w-[11rem] shrink-0 cursor-default transition-colors",
              on ? "bg-bg-200 text-text-100" : "text-text-300 hover:bg-bg-200/60",
            )}
          >
            <TabIcon src={icons[tab.id]} />
            <span className="min-w-0 truncate">{label}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              aria-label={t.closeTab}
              className={cn(
                "shrink-0 p-0.5 rounded text-text-400 hover:text-text-100 hover:bg-bg-300 transition-opacity",
                on ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={newTab}
        aria-label={t.newTab}
        data-tooltip={t.newTab}
        data-tooltip-kbd="Ctrl+T"
        aria-keyshortcuts="Ctrl+T"
        className="shrink-0 p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-200"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );

  return (
    <>
      {tabs.map((tab) => (
        <div key={tab.id} className={cn("h-full", tab.id !== activeId && "hidden")}>
          <PreviewPage
            {...props}
            requestedFile={routed.byTab[tab.id]}
            slot={slot}
            onUserLoad={onUserLoad}
            front={tab.id === activeId}
            active={visible && tab.id === activeId}
            fresh={tab.fresh}
            strip={strip}
            tabId={tab.id}
            onLabel={setLabel}
            onIcon={setIcon}
            restored={restored?.pages[tab.id]}
            onSnapshot={onSnapshot}
          />
        </div>
      ))}
    </>
  );
}
