import { useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { ArrowUpDown, ChevronDown, Globe, ListFilter, MessageCircle, Plus, Upload } from "lucide-react";
import type { ConnectorCatalogEntry } from "@/lib/mcp";
import { addMarketplace, getCatalog, removeMarketplace } from "@/lib/plugins";
import { isTauri } from "@/lib/plugins/paths";
import { localizedError, useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CustomConnectorModal } from "@/components/settings/ConnectorDirectory";
import { useConnectors } from "@/components/customize/useConnectors";
import { usePluginsData, notifyPluginsChanged } from "@/components/customize/usePluginsData";
import { PluginsTab, type PluginFilter, type PluginSort } from "@/components/customize/PluginsTab";
import { DiscoverConnectors, YoursTable } from "@/components/customize/ConnectorsTab";
import { ConnectorDetail } from "@/components/customize/ConnectorDetail";
import { DirectoryDialog, type DirectoryTab } from "@/components/customize/DirectoryDialog";
import { AddMarketplaceDialog } from "@/components/customize/AddMarketplaceDialog";
import { connectorCategories, kindCount, NO_FILTER, type ConnectorFilter, type ConnectorKind } from "@/components/customize/connectorData";
import {
  Dropdown, MenuItem, MenuLabel, MenuSeparator, PillTabs, SearchBox, SegmentedTabs,
} from "@/components/customize/ui";

type MainTab = "plugins" | "connectors";
type ConnView = "yours" | "discover";

function IconButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={active}
      onClick={onClick}
      className={cn(
        "w-8 h-8 rounded-[6px] flex items-center justify-center text-text-300 hover:bg-bg-200 hover:text-text-100",
        active && "bg-bg-200 text-text-100",
      )}
    >
      {children}
    </button>
  );
}

function AddButton({ children }: { children: (close: () => void) => React.ReactNode }) {
  const t = useTranslations().customizePage;
  return (
    <Dropdown
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 h-8 pl-3 pr-2.5 rounded-[6px] bg-text-100 text-bg-0 text-[14px] font-medium hover:opacity-90"
        >
          {t.add}
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}
      className="min-w-[210px]"
    >
      {children}
    </Dropdown>
  );
}

/**
 * Customize: the installed plugins and skills, and the connectors (the user's and a directory
 * to discover more), with a directory dialog to browse and add new ones.
 */
export function CustomizePanel({
  workspace,
  onStartChat,
}: {
  workspace: string | null;
  /** Opens a new chat that starts with this message. */
  onStartChat?: (title: string, prompt: string) => void;
}) {
  const t = useTranslations().customizePage;
  const connectors = useConnectors();
  const plugins = usePluginsData(workspace);
  const [tab, setTab] = useState<MainTab>("plugins");
  const [connView, setConnView] = useState<ConnView>(() =>
    connectors.servers.length + connectors.configServers.length > 0 ? "yours" : "discover",
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PluginSort>("recent");
  const [pluginFilter, setPluginFilter] = useState<PluginFilter>("all");
  const [connFilter, setConnFilter] = useState<ConnectorFilter>(NO_FILTER);
  const [detail, setDetail] = useState<ConnectorCatalogEntry | null>(null);
  const [directory, setDirectory] = useState<DirectoryTab | null>(null);
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const switchTab = (next: MainTab) => {
    setTab(next);
    setQuery("");
    setDetail(null);
  };

  const openDetail = (entry: ConnectorCatalogEntry) => {
    setDetail(entry);
    document.getElementById("customize-scroll")?.scrollTo({ top: 0 });
  };

  const uploadPlugin = async () => {
    if (!isTauri) return;
    const picked = await openFolderDialog({ directory: true, multiple: false, title: t.uploadPlugin });
    if (typeof picked !== "string") return;
    plugins.setError(null);
    let added: string | null = null;
    try {
      const mp = await addMarketplace({ source: "directory", path: picked });
      added = mp.name;
      await getCatalog(mp, { force: true });
      notifyPluginsChanged();
      setDirectory("plugins");
    } catch (e) {
      if (added) await removeMarketplace(added).catch(() => undefined);
      plugins.setError(`${t.uploadFailed} ${localizedError(e)}`);
    }
  };

  const categories = connectorCategories();
  const kinds: { id: ConnectorKind; label: string }[] = [
    { id: "all", label: t.kindAll },
    { id: "trending", label: t.kindTrending },
    { id: "new", label: t.kindNew },
    { id: "verified", label: t.kindVerified },
    { id: "noAuth", label: t.kindNoAuth },
  ];
  const setFilterAndDiscover = (f: ConnectorFilter) => {
    setConnFilter(f);
    setConnView("discover");
  };

  return (
    <div
      id="customize-scroll"
      className="flex-1 overflow-y-auto custom-scrollbar"
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 8)}
    >
      {detail ? (
        <div className="px-10 pt-12 pb-16">
          <ConnectorDetail
            entry={detail}
            connectors={connectors}
            onBack={() => setDetail(null)}
            onOpen={openDetail}
            backLabel={t.connectors}
          />
        </div>
      ) : (
        <>
          <header className={cn("sticky top-0 z-20 bg-bg-0 transition-shadow", scrolled && "border-b border-bg-300")}>
            <div className="max-w-[960px] mx-auto px-8 pt-10 pb-4">
              <h1 className="text-[28px] font-serif text-text-100 mb-6">{t.title}</h1>
              <div className="flex items-center gap-2">
                <PillTabs
                  value={tab}
                  onChange={switchTab}
                  items={[
                    { id: "plugins", label: t.plugins },
                    { id: "connectors", label: t.connectors },
                  ]}
                />
                {tab === "connectors" && (
                  <>
                    <span className="w-px h-5 bg-bg-300 mx-2" />
                    <SegmentedTabs
                      value={connView}
                      onChange={setConnView}
                      items={[
                        { id: "yours", label: t.yours },
                        { id: "discover", label: t.discover },
                      ]}
                    />
                  </>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <SearchBox
                    value={query}
                    onChange={setQuery}
                    placeholder={tab === "plugins" ? t.searchSkillsPlugins : t.search}
                    className="w-64"
                  />
                  {tab === "plugins" ? (
                    <>
                      <Dropdown trigger={(open, toggle) => (
                        <IconButton label={t.filter} active={open || pluginFilter !== "all"} onClick={toggle}>
                          <ListFilter className="w-4 h-4" />
                        </IconButton>
                      )}>
                        {(close) =>
                          ([
                            ["all", t.filterAll],
                            ["plugins", t.filterPlugins],
                            ["skills", t.filterSkills],
                            ["on", t.filterOn],
                            ["off", t.filterOff],
                          ] as [PluginFilter, string][]).map(([id, label]) => (
                            <MenuItem key={id} label={label} checked={pluginFilter === id} onClick={() => { setPluginFilter(id); close(); }} />
                          ))
                        }
                      </Dropdown>
                      <Dropdown trigger={(open, toggle) => (
                        <IconButton label={t.sort} active={open} onClick={toggle}>
                          <ArrowUpDown className="w-4 h-4" />
                        </IconButton>
                      )}>
                        {(close) => (
                          <>
                            <MenuItem label={t.sortRecent} checked={sort === "recent"} onClick={() => { setSort("recent"); close(); }} />
                            <MenuItem label={t.sortName} checked={sort === "name"} onClick={() => { setSort("name"); close(); }} />
                          </>
                        )}
                      </Dropdown>
                      <button
                        type="button"
                        onClick={() => setDirectory("plugins")}
                        className="h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-100 hover:bg-bg-300"
                      >
                        {t.discover}
                      </button>
                      <AddButton>
                        {(close) => (
                          <>
                            <MenuItem icon={<Globe className="w-4 h-4" />} label={t.addMarketplace} onClick={() => { close(); setAddMarketplaceOpen(true); }} />
                            <MenuItem icon={<Upload className="w-4 h-4" />} label={t.uploadPlugin} disabled={!isTauri} onClick={() => { close(); void uploadPlugin(); }} />
                            {onStartChat && (
                              <MenuItem
                                icon={<MessageCircle className="w-4 h-4" />}
                                label={t.createWithNyxs}
                                onClick={() => { close(); onStartChat(t.createPluginTitle, t.createPluginPrompt); }}
                              />
                            )}
                          </>
                        )}
                      </AddButton>
                    </>
                  ) : (
                    <>
                      <Dropdown
                        className="min-w-[260px]"
                        trigger={(open, toggle) => (
                          <IconButton label={t.filter} active={open || connFilter !== NO_FILTER} onClick={toggle}>
                            <ListFilter className="w-4 h-4" />
                          </IconButton>
                        )}
                      >
                        {(close) => (
                          <>
                            <MenuItem
                              label={t.allCategories}
                              checked={!connFilter.category}
                              onClick={() => { setFilterAndDiscover({ ...connFilter, category: null }); close(); }}
                            />
                            <MenuSeparator />
                            {categories.map((c) => (
                              <MenuItem
                                key={c.name}
                                label={c.name}
                                count={c.count}
                                checked={connFilter.category === c.name}
                                onClick={() => { setFilterAndDiscover({ ...connFilter, category: c.name }); close(); }}
                              />
                            ))}
                            <MenuSeparator />
                            <MenuLabel>{t.type}</MenuLabel>
                            {kinds.map((k) => (
                              <MenuItem
                                key={k.id}
                                label={k.label}
                                checked={connFilter.kind === k.id}
                                count={k.id === "all" ? undefined : kindCount(k.id)}
                                onClick={() => { setFilterAndDiscover({ ...connFilter, kind: k.id }); close(); }}
                              />
                            ))}
                          </>
                        )}
                      </Dropdown>
                      <AddButton>
                        {(close) => (
                          <MenuItem
                            icon={<Plus className="w-4 h-4" />}
                            label={t.addCustomConnector}
                            onClick={() => { close(); connectors.openCustom(null); }}
                          />
                        )}
                      </AddButton>
                    </>
                  )}
                </div>
              </div>
            </div>
          </header>

          <div className="max-w-[960px] mx-auto px-8 pt-4">
            {tab === "plugins" ? (
              <PluginsTab
                items={plugins.items}
                error={plugins.error}
                onError={plugins.setError}
                query={query}
                sort={sort}
                filter={pluginFilter}
                workspace={workspace}
              />
            ) : connView === "yours" ? (
              <YoursTable
                connectors={connectors}
                query={query}
                onOpen={openDetail}
                onDiscover={() => setConnView("discover")}
              />
            ) : (
              <DiscoverConnectors
                connectors={connectors}
                query={query}
                filter={connFilter}
                onFilter={setConnFilter}
                onOpen={openDetail}
              />
            )}
          </div>
        </>
      )}

      {directory && (
        <DirectoryDialog
          tab={directory}
          onTab={setDirectory}
          onClose={() => setDirectory(null)}
          connectors={connectors}
          workspace={workspace}
          onAddMarketplace={() => setAddMarketplaceOpen(true)}
        />
      )}
      {addMarketplaceOpen && (
        <AddMarketplaceDialog
          stacked={!!directory}
          onClose={() => setAddMarketplaceOpen(false)}
          onBrowseOfficial={() => {
            setAddMarketplaceOpen(false);
            setDirectory("plugins");
          }}
        />
      )}
      {connectors.customPrefill !== undefined && (
        <CustomConnectorModal
          prefill={connectors.customPrefill}
          existingNames={connectors.servers.map((s) => s.name)}
          onAdd={connectors.addServer}
          onClose={connectors.closeCustom}
        />
      )}
    </div>
  );
}
