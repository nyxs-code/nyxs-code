import { useState } from "react";
import { Blocks, Check, ChevronDown, Plug, ScrollText } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SkillsDirectory } from "@/components/SkillsDirectory";
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from "@/lib/mcp";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ConnectorLogo } from "./logos";
import { byPopularity, catalogEntryFor, filterConnectors, kindCount, type ConnectorKind } from "./connectorData";
import { ConnectorCard } from "./ConnectorRow";
import { ConnectorDetail } from "./ConnectorDetail";
import { PluginDirectory } from "./PluginDirectory";
import { Dropdown, MenuItem, SearchBox, SquareAction } from "./ui";
import type { Connectors } from "./useConnectors";

export type DirectoryTab = "connectors" | "plugins" | "skills";

function ConnectorsPane({ connectors }: { connectors: Connectors }) {
  const t = useTranslations().customizePage;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ConnectorKind>("all");
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<ConnectorCatalogEntry | null>(null);

  if (selected) {
    return (
      <ConnectorDetail
        entry={selected}
        connectors={connectors}
        onBack={() => setSelected(null)}
        onOpen={setSelected}
        backLabel={t.connectors}
      />
    );
  }

  const kinds: { id: ConnectorKind; label: string }[] = [
    { id: "all", label: t.kindAll },
    { id: "trending", label: t.kindTrending },
    { id: "new", label: t.kindNew },
    { id: "verified", label: t.kindVerified },
    { id: "noAuth", label: t.kindNoAuth },
  ];
  const searching = query.trim() !== "" || kind !== "all";
  const custom = connectors.servers.filter((s) => !catalogEntryFor(s));
  const popular = byPopularity(CONNECTOR_CATALOG);
  const list = searching ? filterConnectors(query, { category: null, kind }) : showAll ? popular : popular.slice(0, 12);

  return (
    <div>
      <div className="flex items-center gap-2">
        <SearchBox value={query} onChange={setQuery} placeholder={t.searchConnectors} size="lg" autoFocus className="flex-1" />
        <Dropdown
          trigger={(open, toggle) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-[6px] bg-bg-200 text-[14px] text-text-200 hover:text-text-100"
            >
              {t.filterValue.replace("{value}", kinds.find((k) => k.id === kind)?.label ?? "")}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          )}
        >
          {(close) =>
            kinds.map((k) => (
              <MenuItem
                key={k.id}
                label={k.label}
                checked={kind === k.id}
                count={k.id === "all" ? undefined : kindCount(k.id)}
                onClick={() => { setKind(k.id); close(); }}
              />
            ))
          }
        </Dropdown>
      </div>

      {connectors.error && <p className="text-[12px] text-red-400 mt-3 break-words">{connectors.error}</p>}

      {!searching && custom.length > 0 && (
        <section className="mt-6">
          <h3 className="text-[15px] font-medium text-text-100 mb-3">{t.yourCustomConnectors}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {custom.map((s) => {
              let host = s.url;
              try {
                host = s.url ? new URL(s.url).host : s.command ?? "";
              } catch {
                /* not a URL: shown as written */
              }
              return (
                <div key={s.id} className="flex items-start gap-3.5 p-3.5 rounded-[8px] bg-bg-200/60">
                  <ConnectorLogo entry={{ name: s.name }} size={48} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-medium text-text-100 truncate">{s.name}</p>
                    <p className="text-[13px] text-text-300 truncate">{host}</p>
                    <p className="flex items-center gap-1.5 text-[13px] text-text-400 mt-0.5">
                      <span className="h-[18px] px-1.5 inline-flex items-center rounded-[5px] bg-bg-300/70 text-[10.5px] text-text-300">
                        {t.badgeCustom}
                      </span>
                      · {t.connectorKind}
                    </p>
                  </div>
                  <SquareAction label={s.enabled ? t.connected : t.turnOn} tone={s.enabled ? "success" : "gray"} onClick={s.enabled ? undefined : () => connectors.enable(s.id)} disabled={s.enabled}>
                    <Check className="w-4 h-4" />
                  </SquareAction>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="mt-6">
        <div className="flex items-center mb-3">
          <h3 className="text-[15px] font-medium text-text-100">{searching ? t.results : t.mostPopular}</h3>
          {!searching && CONNECTOR_CATALOG.length > 12 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="ml-auto text-[14px] text-text-100 hover:underline">
              {showAll ? t.showLess : t.showAll}
            </button>
          )}
        </div>
        {list.length ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {list.map((c) => (
              <ConnectorCard key={c.url} entry={c} connectors={connectors} onOpen={() => setSelected(c)} />
            ))}
          </div>
        ) : (
          <p className="py-8 text-[13px] text-text-400">{t.noResults}</p>
        )}
      </section>
    </div>
  );
}

/** The directory over the Customize page: connectors, plugins and skills to add. */
export function DirectoryDialog({
  tab,
  onTab,
  onClose,
  connectors,
  workspace,
  onAddMarketplace,
}: {
  tab: DirectoryTab;
  onTab: (t: DirectoryTab) => void;
  onClose: () => void;
  connectors: Connectors;
  workspace: string | null;
  onAddMarketplace: () => void;
}) {
  const t = useTranslations().customizePage;
  const nav: { id: DirectoryTab; label: string; icon: typeof Blocks }[] = [
    { id: "connectors", label: t.connectors, icon: Blocks },
    { id: "plugins", label: t.plugins, icon: Plug },
    { id: "skills", label: t.skills, icon: ScrollText },
  ];
  return (
    <Dialog open onClose={onClose} className="max-w-[1240px] h-[min(900px,100%)] overflow-hidden">
      <DialogHeader className="px-5 pt-4 pb-2">
        <DialogTitle className="text-[17px] font-serif font-normal">{t.directory}</DialogTitle>
      </DialogHeader>
      <div className="flex-1 flex min-h-0">
        <nav className="w-56 shrink-0 px-3 py-2 space-y-0.5">
          {nav.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => onTab(it.id)}
              className={cn(
                "w-full flex items-center gap-2.5 h-9 px-3 rounded-[6px] text-[14px] transition-colors",
                tab === it.id ? "bg-bg-200 text-text-100 font-medium" : "text-text-200 hover:bg-bg-200/60",
              )}
            >
              <it.icon className={cn("w-4 h-4 text-text-300", it.id === "plugins" && "rotate-45")} strokeWidth={1.75} />
              {it.label}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 overflow-y-auto custom-scrollbar px-6 pt-2 pb-6">
          {tab === "connectors" && <ConnectorsPane connectors={connectors} />}
          {tab === "plugins" && <PluginDirectory onAddMarketplace={onAddMarketplace} />}
          {tab === "skills" && <SkillsDirectory workspace={workspace} />}
        </div>
      </div>
    </Dialog>
  );
}
