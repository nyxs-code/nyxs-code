import { useEffect, useState } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Loader2, MoreHorizontal,
  Plug, Power, Trash2, Info,
} from "lucide-react";
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry, type McpServer } from "@/lib/mcp";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ConnectorLogo } from "./logos";
import {
  byPopularity, catalogEntryFor, connectorCategories, filterConnectors, NO_FILTER, type ConnectorFilter,
} from "./connectorData";
import { ConnectorRow, RowGrid } from "./ConnectorRow";
import { CountBadge, Dropdown, MenuItem } from "./ui";
import type { Connectors } from "./useConnectors";

/** The table of the user's connectors: added ones, then those from settings files and plugins. */
export function YoursTable({
  connectors,
  query,
  onOpen,
  onDiscover,
}: {
  connectors: Connectors;
  query: string;
  onOpen: (entry: ConnectorCatalogEntry) => void;
  onDiscover: () => void;
}) {
  const t = useTranslations().customizePage;
  const q = query.trim().toLowerCase();
  const match = (s: McpServer) => !q || s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q);
  const own = connectors.servers.filter(match);
  const fromConfig = connectors.configServers.filter(match);

  if (connectors.servers.length === 0 && connectors.configServers.length === 0) {
    return (
      <div className="flex flex-col items-center text-center py-20">
        <span className="w-12 h-12 rounded-[8px] border border-bg-300 flex items-center justify-center text-text-400 mb-4">
          <Plug className="w-5 h-5" />
        </span>
        <p className="text-[15px] text-text-100">{t.noConnectorsTitle}</p>
        <p className="text-[13px] text-text-400 mt-1 max-w-sm">{t.noConnectorsHint}</p>
        <button
          type="button"
          onClick={onDiscover}
          className="mt-5 h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-100 hover:bg-bg-300"
        >
          {t.discoverConnectors}
        </button>
      </div>
    );
  }

  return (
    <div className="pb-10">
      <div className="grid grid-cols-[minmax(0,1fr)_170px_170px_32px] items-center px-3 h-9 text-[13px] text-text-400 border-b border-bg-300">
        <span>{t.colConnector}</span>
        <span>{t.colType}</span>
        <span>{t.colStatus}</span>
        <span />
      </div>
      {own.map((s) => (
        <YoursRow key={s.id} server={s} connectors={connectors} onOpen={onOpen} />
      ))}
      {fromConfig.map((s) => (
        <YoursRow key={s.id} server={s} connectors={connectors} onOpen={onOpen} readOnly />
      ))}
      {own.length + fromConfig.length === 0 && (
        <p className="px-3 py-6 text-[13px] text-text-400">{t.noResults}</p>
      )}
    </div>
  );
}

function YoursRow({
  server,
  connectors,
  onOpen,
  readOnly,
}: {
  server: McpServer;
  connectors: Connectors;
  onOpen: (entry: ConnectorCatalogEntry) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations().customizePage;
  const entry = catalogEntryFor(server);
  const status = connectors.statuses[server.id];
  const fromPlugin = server.source === "plugin";
  const badge = readOnly ? (fromPlugin ? t.badgePlugin : t.badgeConfig) : entry ? null : t.badgeCustom;
  const kind = server.url ? t.typeWeb : t.typeLocal;
  const subline = readOnly ? (fromPlugin ? t.providedByPlugin : t.fromSettingsFile) : null;

  let state: React.ReactNode;
  if (readOnly) {
    state = <span className="text-[13px] text-text-300">{t.connectsInSessions}</span>;
  } else if (!server.enabled) {
    state = (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); connectors.toggle(server.id); }}
        className="h-7 px-2.5 rounded-[6px] bg-bg-200 text-[13px] text-text-100 hover:bg-bg-300"
      >
        {t.connect}
      </button>
    );
  } else if (status?.state === "connecting") {
    state = <Loader2 className="w-4 h-4 text-text-400 animate-spin" />;
  } else if (status?.state === "error") {
    state = (
      <span className="flex items-center gap-2">
        <span data-tooltip={status.error}>
          <AlertTriangle className="w-4 h-4 text-amber-500" />
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); connectors.retry(); }}
          className="h-7 px-2.5 rounded-[6px] bg-text-100 text-bg-0 text-[13px] hover:opacity-90"
        >
          {t.reconnect}
        </button>
      </span>
    );
  } else {
    state = <Check className="w-4 h-4 text-text-300" aria-label={t.connected} />;
  }

  return (
    <div
      onClick={entry ? () => onOpen(entry) : undefined}
      className={cn(
        "group grid grid-cols-[minmax(0,1fr)_170px_170px_32px] items-center px-3 min-h-[45px] py-2 border-b border-bg-300",
        entry && "cursor-pointer hover:bg-bg-200/40",
      )}
    >
      <span className="flex items-center gap-3 min-w-0">
        <ConnectorLogo entry={entry ?? { name: server.name }} size={22} />
        <span className="min-w-0">
          <span className="block text-[14px] font-medium text-text-100 truncate">{server.name}</span>
          {subline && <span className="block text-[13px] text-text-400 truncate">{subline}</span>}
        </span>
      </span>
      <span className="flex items-center gap-2 min-w-0 text-[13px] text-text-300">
        {kind}
        {badge && (
          <span className="px-1.5 h-[18px] inline-flex items-center rounded-[5px] bg-bg-200 text-[10.5px] text-text-400 truncate">
            {badge}
          </span>
        )}
      </span>
      <span className="flex items-center">{state}</span>
      <span className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        {!readOnly && (
          <Dropdown
            trigger={(open, toggle) => (
              <button
                type="button"
                onClick={toggle}
                aria-label={t.moreOptions}
                className={cn(
                  "w-7 h-7 rounded-[6px] flex items-center justify-center text-text-400 hover:bg-bg-200 hover:text-text-100",
                  open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
                )}
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
            )}
          >
            {(close) => (
              <>
                {entry && (
                  <MenuItem icon={<Info className="w-4 h-4" />} label={t.details} onClick={() => { close(); onOpen(entry); }} />
                )}
                <MenuItem
                  icon={<Power className="w-4 h-4" />}
                  label={server.enabled ? t.turnOff : t.turnOn}
                  onClick={() => { connectors.toggle(server.id); close(); }}
                />
                <MenuItem
                  danger
                  icon={<Trash2 className="w-4 h-4" />}
                  label={t.removeConnector}
                  onClick={() => { connectors.remove(server.id); close(); }}
                />
              </>
            )}
          </Dropdown>
        )}
      </span>
    </div>
  );
}

type Slide = { eyebrow?: string; title: string; subtitle: string; items: ConnectorCatalogEntry[]; category: string | null };

/** The banner at the top of Discover: a few hand-picked groups, one at a time. */
function Carousel({ slides, onExplore }: { slides: Slide[]; onExplore: (s: Slide) => void }) {
  const t = useTranslations().customizePage;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = slides.length;

  useEffect(() => {
    if (paused || count < 2) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % count), 7000);
    return () => window.clearInterval(id);
  }, [paused, count]);

  if (count === 0) return null;
  const go = (d: number) => setIndex((i) => (i + d + count) % count);

  return (
    <div className="mb-10" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div
        className="relative h-[280px] rounded-[8px] border border-bg-300 overflow-hidden"
        style={{
          background:
            "linear-gradient(to bottom, var(--color-bg-0, transparent) 30%, color-mix(in srgb, #9fb8ad 55%, transparent) 100%)",
        }}
      >
        {slides.map((s, i) => (
          <div
            key={s.title}
            aria-hidden={i !== index}
            className={cn(
              "absolute inset-0 flex flex-col items-center pt-9 px-24 text-center transition-opacity duration-500",
              i === index ? "opacity-100" : "opacity-0 pointer-events-none",
            )}
          >
            {s.eyebrow && <p className="text-[12px] font-medium tracking-wide uppercase text-text-300 mb-1">{s.eyebrow}</p>}
            <h3 className="text-[22px] text-text-100">{s.title}</h3>
            <p className="text-[13px] text-text-300 mt-1">{s.subtitle}</p>
            <div className="flex items-start justify-center gap-5 mt-6 h-[72px]">
              {s.items.slice(0, 7).map((c, k) => (
                <span
                  key={c.url}
                  className="drop-shadow-sm"
                  style={{ transform: `translateY(${k % 2 ? 14 : 0}px)` }}
                >
                  <ConnectorLogo entry={c} size={k % 2 ? 42 : 50} />
                </span>
              ))}
            </div>
            <button
              type="button"
              tabIndex={i === index ? 0 : -1}
              onClick={() => onExplore(s)}
              className="mt-5 h-10 px-4 rounded-[8px] bg-bg-0/70 border border-bg-300 text-[15px] text-text-100 backdrop-blur hover:bg-bg-0"
            >
              {t.explore}
            </button>
          </div>
        ))}
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label={t.previous}
              className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-bg-0/80 border border-bg-300 flex items-center justify-center text-text-200 hover:bg-bg-0"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label={t.next}
              className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-bg-0/80 border border-bg-300 flex items-center justify-center text-text-200 hover:bg-bg-0"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
      {count > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-3">
          {slides.map((s, i) => (
            <button
              key={s.title}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={s.title}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === index ? "w-8 bg-text-100" : "w-1.5 bg-text-500/50 hover:bg-text-400",
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHead({ title, count, onShowAll }: { title: string; count: number; onShowAll?: () => void }) {
  const t = useTranslations().customizePage;
  return (
    <div className="flex items-center gap-2 mb-1">
      <h2 className="text-[15px] font-medium text-text-100">{title}</h2>
      <CountBadge n={count} />
      {onShowAll && (
        <button
          type="button"
          onClick={onShowAll}
          className="ml-auto inline-flex items-center gap-1.5 text-[14px] text-text-100 hover:underline"
        >
          {t.showAll}
          <ArrowRight className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

type ListView = { title: string; items: ConnectorCatalogEntry[] };

/** Discover: the banner, the popular and trending groups, a group per category and the
 *  category chips. A search or filter shows the matching connectors instead. */
export function DiscoverConnectors({
  connectors,
  query,
  filter,
  onFilter,
  onOpen,
}: {
  connectors: Connectors;
  query: string;
  filter: ConnectorFilter;
  onFilter: (f: ConnectorFilter) => void;
  onOpen: (entry: ConnectorCatalogEntry) => void;
}) {
  const t = useTranslations().customizePage;
  const [list, setList] = useState<ListView | null>(null);
  const categories = connectorCategories();
  const searching = query.trim() !== "" || filter.category !== null || filter.kind !== "all";

  const errorLine = connectors.error && (
    <p className="text-[13px] text-red-400 mb-4 break-words">{connectors.error}</p>
  );
  const connectingLine = connectors.connecting && (
    <p className="flex items-center gap-2 text-[13px] text-text-300 mb-4">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      {t.connectingHint.replace("{name}", connectors.connecting)}
    </p>
  );

  if (searching) {
    const results = filterConnectors(query, filter);
    return (
      <div className="pb-10">
        {connectingLine}
        {errorLine}
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-[15px] font-medium text-text-100">{filter.category ?? t.results}</h2>
          <CountBadge n={results.length} />
          {(filter.category || filter.kind !== "all") && (
            <button type="button" onClick={() => onFilter(NO_FILTER)} className="ml-auto text-[13px] text-text-300 hover:text-text-100">
              {t.clearFilters}
            </button>
          )}
        </div>
        {results.length ? (
          <RowGrid>
            {results.map((c) => (
              <ConnectorRow key={c.url} entry={c} connectors={connectors} onOpen={() => onOpen(c)} />
            ))}
          </RowGrid>
        ) : (
          <p className="py-8 text-[13px] text-text-400">{t.noResults}</p>
        )}
      </div>
    );
  }

  if (list) {
    return (
      <div className="pb-10">
        <button
          type="button"
          onClick={() => setList(null)}
          className="inline-flex items-center gap-1.5 text-[14px] text-text-200 hover:text-text-100 mb-5"
        >
          <ArrowLeft className="w-4 h-4" />
          {t.discover}
        </button>
        {connectingLine}
        {errorLine}
        <SectionHead title={list.title} count={list.items.length} />
        <RowGrid>
          {list.items.map((c) => (
            <ConnectorRow key={c.url} entry={c} connectors={connectors} onOpen={() => onOpen(c)} />
          ))}
        </RowGrid>
      </div>
    );
  }

  const popular = byPopularity(CONNECTOR_CATALOG);
  const trending = popular.filter((c) => c.trending);
  const inCategory = (name: string) => popular.filter((c) => c.category === name);
  const slides: Slide[] = [
    { title: t.featuredTitle, subtitle: t.featuredSubtitle, items: popular, category: null },
    ...categories.slice(0, 3).map((c) => ({
      eyebrow: t.curatedByNyxs,
      title: c.name,
      subtitle: t.categorySubtitle.replace("{count}", String(c.count)),
      items: inCategory(c.name),
      category: c.name,
    })),
  ];

  return (
    <div className="pb-10">
      <Carousel
        slides={slides}
        onExplore={(s) =>
          s.category
            ? setList({ title: s.category, items: inCategory(s.category) })
            : setList({ title: t.mostPopular, items: popular })
        }
      />
      {connectingLine}
      {errorLine}

      <section className="mb-10">
        <SectionHead
          title={t.mostPopular}
          count={CONNECTOR_CATALOG.length}
          onShowAll={() => setList({ title: t.mostPopular, items: popular })}
        />
        <RowGrid>
          {popular.slice(0, 10).map((c) => (
            <ConnectorRow key={c.url} entry={c} connectors={connectors} onOpen={() => onOpen(c)} />
          ))}
        </RowGrid>
      </section>

      {trending.length > 0 && (
        <section className="mb-10">
          <SectionHead
            title={t.trending}
            count={trending.length}
            onShowAll={() => setList({ title: t.trending, items: trending })}
          />
          <RowGrid>
            {trending.slice(0, 6).map((c) => (
              <ConnectorRow key={c.url} entry={c} connectors={connectors} onOpen={() => onOpen(c)} />
            ))}
          </RowGrid>
        </section>
      )}

      {categories
        .filter((c) => c.count >= 2)
        .slice(0, 4)
        .map((cat) => (
          <section key={cat.name} className="mb-10">
            <SectionHead
              title={cat.name}
              count={cat.count}
              onShowAll={() => setList({ title: cat.name, items: inCategory(cat.name) })}
            />
            <RowGrid>
              {inCategory(cat.name)
                .slice(0, 6)
                .map((c) => (
                  <ConnectorRow key={c.url} entry={c} connectors={connectors} onOpen={() => onOpen(c)} />
                ))}
            </RowGrid>
          </section>
        ))}

      <section>
        <h2 className="text-[15px] font-medium text-text-100 mb-4">{t.categories}</h2>
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => setList({ title: c.name, items: inCategory(c.name) })}
              className="h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-200 hover:bg-bg-300 hover:text-text-100"
            >
              {c.name} <span className="text-text-400">{c.count}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
