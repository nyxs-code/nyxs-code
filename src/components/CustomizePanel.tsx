import { useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Globe, ListFilter, MessageCircle, MoreHorizontal, Plus, RefreshCw, Upload } from "lucide-react";
import type { ConnectorCatalogEntry } from "@/lib/mcp";
import { addMarketplace, getCatalog, refreshAllMarketplaces, removeMarketplace } from "@/lib/plugins";
import { isTauri } from "@/lib/plugins/paths";
import { localizedError, useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CustomConnectorModal } from "@/components/settings/ConnectorDirectory";
import { useConnectors } from "@/components/customize/useConnectors";
import { usePluginsData, notifyPluginsChanged } from "@/components/customize/usePluginsData";
import { usePluginCatalog } from "@/components/customize/usePluginCatalog";
import { PluginsHome, type HomeView, type Scope } from "@/components/customize/PluginsHome";
import { ConnectorDetail } from "@/components/customize/ConnectorDetail";
import { PluginDetail, type PluginTarget } from "@/components/customize/PluginDetail";
import { AddMarketplaceDialog } from "@/components/customize/AddMarketplaceDialog";
import { connectorCategories, kindCount, NO_FILTER, type ConnectorFilter, type ConnectorKind } from "@/components/customize/connectorData";
import { Dropdown, MenuItem, MenuLabel, MenuSeparator, SearchBox, SegmentedTabs } from "@/components/customize/ui";

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

/**
 * Plugins, laid out as Claude's page: the title with its menu, a toolbar (search, All ·
 * Connectors · Skills, filter, Add), then the user's own plugins, connectors and skills and the
 * directory in sections. A plugin or connector opens its own page in place.
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
  const catalog = usePluginCatalog();
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConnectorFilter>(NO_FILTER);
  const [view, setView] = useState<HomeView>(null);
  const [detail, setDetail] = useState<ConnectorCatalogEntry | null>(null);
  const [pluginPage, setPluginPage] = useState<PluginTarget | null>(null);
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const toTop = () => document.getElementById("customize-scroll")?.scrollTo({ top: 0 });
  const openDetail = (entry: ConnectorCatalogEntry) => {
    setDetail(entry);
    toTop();
  };
  const openPlugin = (target: PluginTarget) => {
    setPluginPage(target);
    toTop();
  };
  const changeScope = (next: Scope) => {
    setScope(next);
    setView(null);
    toTop();
  };
  const changeView = (next: HomeView) => {
    setView(next);
    toTop();
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
      const found = (await getCatalog(mp, { force: true })).plugins;
      notifyPluginsChanged();
      // One plugin opens its page, with Install; a folder of several lists them.
      if (found.length === 1) openPlugin({ marketplace: mp.name, name: found[0].name });
      else changeScope("skills");
    } catch (e) {
      if (added) await removeMarketplace(added).catch(() => undefined);
      plugins.setError(`${t.uploadFailed} ${localizedError(e)}`);
    }
  };

  /** Reads every marketplace again, so the plugins with a newer version show Update. */
  const checkAll = async () => {
    setChecking(true);
    try {
      await refreshAllMarketplaces();
      notifyPluginsChanged();
    } finally {
      setChecking(false);
    }
  };

  const categories = connectorCategories();
  const kinds: { id: ConnectorKind; label: string }[] = [
    { id: "trending", label: t.kindTrending },
    { id: "new", label: t.kindNew },
    { id: "verified", label: t.kindVerified },
    { id: "noAuth", label: t.kindNoAuth },
  ];
  const applyFilter = (f: ConnectorFilter) => {
    setFilter(f);
    setView(null);
    toTop();
  };
  const filtering = filter.category !== null || filter.kind !== "all";

  return (
    <div
      id="customize-scroll"
      className="flex-1 overflow-y-auto custom-scrollbar"
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 8)}
    >
      {pluginPage ? (
        // The page sets its own bottom padding: its files box reaches down to the bottom.
        <div className="px-10 pt-12">
          <PluginDetail
            key={`${pluginPage.marketplace}/${pluginPage.name}`}
            target={pluginPage}
            items={plugins.items}
            catalog={catalog.entries}
            known={catalog.marketplaces}
            onBack={() => setPluginPage(null)}
            onOpen={openPlugin}
            backLabel={t.plugins}
            onError={plugins.setError}
          />
        </div>
      ) : detail ? (
        <div className="px-10 pt-12 pb-16">
          <ConnectorDetail
            entry={detail}
            connectors={connectors}
            onBack={() => setDetail(null)}
            onOpen={openDetail}
            backLabel={t.plugins}
          />
        </div>
      ) : (
        <>
          <header className={cn("sticky top-0 z-20 bg-bg-0 transition-shadow", scrolled && "border-b border-bg-300")}>
            <div className="max-w-[960px] mx-auto px-8 pt-10 pb-4">
              <div className="flex items-center mb-6">
                <h1 className="text-[28px] font-serif text-text-100">{t.plugins}</h1>
                <div className="ml-auto">
                  <Dropdown
                    trigger={(open, toggle) => (
                      <IconButton label={t.moreOptions} active={open} onClick={toggle}>
                        {checking ? <RefreshCw className="w-4 h-4 animate-spin" /> : <MoreHorizontal className="w-4 h-4" />}
                      </IconButton>
                    )}
                    className="min-w-[220px]"
                  >
                    {(close) => (
                      <>
                        <MenuItem
                          icon={<RefreshCw className="w-4 h-4" />}
                          label={t.checkUpdates}
                          disabled={checking}
                          onClick={() => { close(); void checkAll(); }}
                        />
                        <MenuItem icon={<Globe className="w-4 h-4" />} label={t.addMarketplace} onClick={() => { close(); setAddMarketplaceOpen(true); }} />
                      </>
                    )}
                  </Dropdown>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <SearchBox value={query} onChange={(v) => { setQuery(v); setView(null); }} placeholder={t.search} className="flex-1 min-w-0" />
                <SegmentedTabs
                  value={scope}
                  onChange={changeScope}
                  items={[
                    { id: "all", label: t.filterAll },
                    { id: "connectors", label: t.connectors },
                    { id: "skills", label: t.tabSkills },
                  ]}
                />
                <Dropdown
                  className="min-w-[260px]"
                  trigger={(open, toggle) => (
                    <IconButton label={t.filter} active={open || filtering} onClick={toggle}>
                      <ListFilter className="w-4 h-4" />
                    </IconButton>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuItem label={t.allCategories} checked={!filtering} onClick={() => { applyFilter(NO_FILTER); close(); }} />
                      <MenuSeparator />
                      {categories.map((c) => (
                        <MenuItem
                          key={c.name}
                          label={c.name}
                          count={c.count}
                          checked={filter.category === c.name}
                          onClick={() => { applyFilter({ ...filter, category: c.name }); close(); }}
                        />
                      ))}
                      <MenuSeparator />
                      <MenuLabel>{t.type}</MenuLabel>
                      {kinds.map((k) => (
                        <MenuItem
                          key={k.id}
                          label={k.label}
                          checked={filter.kind === k.id}
                          count={kindCount(k.id)}
                          onClick={() => { applyFilter({ ...filter, kind: filter.kind === k.id ? "all" : k.id }); close(); }}
                        />
                      ))}
                    </>
                  )}
                </Dropdown>
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
                  className="min-w-[230px]"
                >
                  {(close) => (
                    <>
                      <MenuItem icon={<Plus className="w-4 h-4" />} label={t.addCustomConnector} onClick={() => { close(); connectors.openCustom(null); }} />
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
                </Dropdown>
              </div>
            </div>
          </header>

          <div className="max-w-[960px] mx-auto px-8 pt-4">
            <PluginsHome
              scope={scope}
              query={query}
              filter={filter}
              onClearFilter={() => applyFilter(NO_FILTER)}
              view={view}
              onView={changeView}
              connectors={connectors}
              items={plugins.items}
              catalog={catalog.entries}
              marketplaces={catalog.marketplaces}
              onOpenConnector={openDetail}
              onOpenPlugin={(it) => it.installed && openPlugin({ marketplace: it.installed.marketplace, name: it.installed.plugin })}
              onOpenCatalogPlugin={(e) => openPlugin({ marketplace: e.marketplace, name: e.name })}
              onStartChat={onStartChat}
              error={plugins.error}
              onError={plugins.setError}
            />
          </div>
        </>
      )}

      {addMarketplaceOpen && (
        <AddMarketplaceDialog
          stacked={false}
          onClose={() => setAddMarketplaceOpen(false)}
          onBrowseOfficial={() => {
            setAddMarketplaceOpen(false);
            setPluginPage(null);
            setDetail(null);
            setScope("skills");
            changeView({ kind: "section", id: "workflows" });
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
