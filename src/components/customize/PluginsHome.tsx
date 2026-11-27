import type { ReactNode } from "react";
import {
  ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck, Braces, ChartLine, CircleDollarSign, Cloud, CodeXml, Database,
  FileText, FlaskConical, Globe, Headphones, Info, ListChecks, Loader2, Mail, Megaphone, MoreHorizontal,
  Palette, Plus, Power, Shield, Sparkles, Tag, Trash2, Workflow, type LucideIcon,
} from "lucide-react";
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry, type McpServer } from "@/lib/mcp";
import { getLanguage, localizedError, useTranslations } from "@/lib/i18n";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { useConfirm } from "@/lib/useConfirm";
import { installPlugin, isBuiltinMarketplace, type KnownMarketplace } from "@/lib/plugins";
import { sourceOf } from "@/lib/plugins/pluginDetails";
import { cn } from "@/lib/utils";
import {
  byPopularity, catalogEntryFor, connectorCategories, filterConnectors, isNewConnector, isVerified,
  type ConnectorFilter,
} from "./connectorData";
import { ConnectorLogo, GithubMark, PluginLogo } from "./logos";
import { PluginMenu } from "./PluginMenu";
import { partsLine } from "./pluginText";
import { Dropdown, MenuItem } from "./ui";
import type { CatalogEntry } from "./usePluginCatalog";
import { usePluginActions } from "./usePluginActions";
import { notifyPluginsChanged, type PluginItem } from "./usePluginsData";
import type { Connectors } from "./useConnectors";

/** Todo · Conectores · Skills. */
export type Scope = "all" | "connectors" | "skills";

/** A "Show all" page: one section's whole list. */
export type HomeView = { kind: "section"; id: SectionId } | { kind: "category"; name: string } | null;

type SectionId = "yours" | "mostUsed" | "workflows" | "trending" | "new";

const DOCS_URL = "https://nyxs.dev/docs/plugins/";
/** How many of the user's own show before the "A, B and 3 more" line. */
const YOURS_SHOWN = 4;

/** One plugin or connector of the directory, as its two-column row draws it. */
interface DirEntry {
  key: string;
  name: string;
  description: string;
  verified: boolean;
  logo: (size: number) => ReactNode;
  /** "Connector", "Hooks and skills", "Plugin"… */
  kind: string;
  /** "By Google", or a repository with GitHub's mark. */
  by?: { text: string; github?: boolean };
  open: () => void;
  /** The "+" a row shows under the pointer: adds it at once. None once it is added. */
  add?: () => void;
  addLabel?: string;
  /** Its sign-in is opening: the "+" shows a spinner and stays in view meanwhile. */
  adding?: boolean;
}

function Meta({ kind, by, badge }: { kind: string; by?: DirEntry["by"]; badge?: string }) {
  return (
    <span className="flex items-center min-w-0 text-[13px] text-text-400">
      {badge && (
        <span className="shrink-0 inline-flex items-center h-4 px-1 mr-1.5 rounded-[4px] bg-bg-200 text-[10.5px] text-text-300">{badge}</span>
      )}
      <span className="shrink-0">{kind}</span>
      {by && (
        <>
          <span className="mx-1.5 shrink-0">·</span>
          {by.github && <GithubMark className="w-3.5 h-3.5 shrink-0 mr-1" />}
          <span className="truncate">{by.text}</span>
        </>
      )}
    </span>
  );
}

function Name({ name, verified }: { name: string; verified: boolean }) {
  const t = useTranslations().customizePage;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="text-[14px] text-text-100 truncate">{name}</span>
      {verified && <BadgeCheck className="w-4 h-4 shrink-0 text-text-400" aria-label={t.verified} strokeWidth={1.75} />}
    </span>
  );
}

function SectionHead({ title, onShowAll }: { title: string; onShowAll?: () => void }) {
  const t = useTranslations().customizePage;
  return (
    <div className="flex items-center mb-2">
      <h2 className="text-[15px] font-medium text-text-100">{title}</h2>
      {onShowAll && (
        <button
          type="button"
          onClick={onShowAll}
          className="ml-auto inline-flex items-center gap-1.5 text-[14px] text-text-100 hover:opacity-80"
        >
          {t.showAll}
          <ArrowRight className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Two columns of rows with a line between them, none under the last row. As in Claude, a row
 * under the pointer turns into a gray card a little wider than the column, its line hidden, with
 * "+" at its top right to add it without opening its page.
 */
function EntryGrid({ entries }: { entries: DirEntry[] }) {
  const t = useTranslations().customizePage;
  const lastRow = entries.length - (entries.length % 2 === 0 ? 2 : 1);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10">
      {entries.map((e, i) => (
        <div
          key={e.key}
          role="button"
          tabIndex={0}
          onClick={e.open}
          onKeyDown={(ev) => { if (ev.key === "Enter" && ev.target === ev.currentTarget) e.open(); }}
          className="group relative -mx-3 px-3 rounded-[8px] cursor-pointer outline-none hover:bg-bg-200/70 focus-visible:bg-bg-200/70"
        >
          <div
            className={cn(
              "flex items-start gap-3 py-3.5 group-hover:border-transparent group-focus-visible:border-transparent",
              i < lastRow && "border-b border-bg-300",
            )}
          >
            <span className="mt-0.5">{e.logo(28)}</span>
            <span className={cn("flex-1 min-w-0", e.add && "pr-8")}>
              <Name name={e.name} verified={e.verified} />
              <span className="block text-[13px] text-text-300 truncate mt-0.5">{e.description}</span>
              <span className="block mt-0.5"><Meta kind={e.kind} by={e.by} /></span>
            </span>
          </div>
          {e.add && (
            <button
              type="button"
              aria-label={e.addLabel ?? t.add}
              disabled={e.adding}
              onClick={(ev) => { ev.stopPropagation(); e.add?.(); }}
              className={cn(
                "absolute right-3 top-3 w-7 h-7 rounded-[6px] border border-bg-300 bg-bg-0 flex items-center justify-center text-text-200 hover:text-text-100 transition-opacity",
                e.adding ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              {e.adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-4 h-4" />}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** A row of the user's own: what it is on two lines, its state and actions on the right. */
function YourRow({ logo, name, verified, meta, right, onOpen }: {
  logo: ReactNode;
  name: string;
  verified: boolean;
  meta: ReactNode;
  right: ReactNode;
  onOpen?: () => void;
}) {
  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(); } : undefined}
      className={cn(
        "flex items-center gap-3 py-2.5 border-b border-bg-300",
        onOpen && "cursor-pointer outline-none focus-visible:bg-bg-200/50",
      )}
    >
      {logo}
      <span className="flex-1 min-w-0">
        <Name name={name} verified={verified} />
        <span className="block mt-0.5">{meta}</span>
      </span>
      {/* Its buttons and menus are inside the row: their clicks mustn't open its page. */}
      <span className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {right}
      </span>
    </div>
  );
}

function MoreButton({ children }: { children: (close: () => void) => ReactNode }) {
  const t = useTranslations().customizePage;
  return (
    <Dropdown
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={t.moreOptions}
          className={cn(
            "w-8 h-8 shrink-0 rounded-[6px] flex items-center justify-center text-text-400 hover:bg-bg-200 hover:text-text-100",
            open && "bg-bg-200 text-text-100",
          )}
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      )}
    >
      {children}
    </Dropdown>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A connector the user added, or one a settings file or a plugin brings. */
function YourConnector({ server, connectors, readOnly, onOpen }: {
  server: McpServer;
  connectors: Connectors;
  readOnly?: boolean;
  onOpen: (entry: ConnectorCatalogEntry) => void;
}) {
  const t = useTranslations().customizePage;
  const entry = catalogEntryFor(server);
  const status = connectors.statuses[server.id];
  const kind = readOnly
    ? server.url ? t.connectorKind : capitalize(t.kindLocalMcp)
    : entry ? t.connectorKind : t.badgeCustom;
  const by = entry?.developer
    ? { text: t.byDeveloper.replace("{name}", entry.developer) }
    : server.url ? { text: hostOf(server.url) } : undefined;
  const badge = readOnly ? (server.source === "plugin" ? t.badgePlugin : t.badgeConfig) : undefined;

  let state: ReactNode = null;
  if (!readOnly && !server.enabled) {
    state = (
      <button type="button" onClick={() => connectors.toggle(server.id)} className="h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-100 hover:bg-bg-300">
        {t.connect}
      </button>
    );
  } else if (!readOnly && status?.state === "error") {
    state = (
      <>
        <span className="max-w-[180px] truncate h-5 inline-flex items-center px-1.5 rounded-[4px] bg-amber-500/10 text-[11px] text-amber-600 dark:text-amber-400">
          {t.connectionFailed}
        </span>
        <button type="button" onClick={connectors.retry} className="h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-100 hover:bg-bg-300">
          {t.reconnect}
        </button>
      </>
    );
  }

  return (
    <YourRow
      logo={<ConnectorLogo entry={entry ?? { name: server.name }} size={28} />}
      name={server.name}
      verified={!!entry && isVerified(entry)}
      meta={<Meta kind={kind} by={by} badge={badge} />}
      onOpen={entry ? () => onOpen(entry) : undefined}
      right={
        <>
          {state}
          {!readOnly && (
            <MoreButton>
              {(close) => (
                <>
                  {entry && <MenuItem icon={<Info className="w-4 h-4" />} label={t.details} onClick={() => { close(); onOpen(entry); }} />}
                  <MenuItem
                    icon={<Power className="w-4 h-4" />}
                    label={server.enabled ? t.turnOff : t.turnOn}
                    onClick={() => { close(); connectors.toggle(server.id); }}
                  />
                  <MenuItem
                    danger
                    icon={<Trash2 className="w-4 h-4" />}
                    label={t.removeConnector}
                    onClick={() => { close(); connectors.remove(server.id); }}
                  />
                </>
              )}
            </MoreButton>
          )}
        </>
      }
    />
  );
}

/** An installed plugin, or a skill of the user's, this project's or Nyxs'. */
function YourPlugin({ item, onError, onOpen }: {
  item: PluginItem;
  onError: (msg: string | null) => void;
  onOpen: (item: PluginItem) => void;
}) {
  const t = useTranslations().customizePage;
  const actions = usePluginActions(item, onError);
  const skill = item.kind === "skill";
  const origin = item.group === "project" ? t.originProject : item.group === "user" ? t.originYou : t.originNyxs;
  const meta = skill ? (
    <Meta kind={t.badgeSkill} by={{ text: origin }} />
  ) : (
    <Meta
      kind={partsLine(item.parts, t) || t.pluginKind}
      by={item.source ? { text: item.source.label, github: true } : item.author ? { text: t.byDeveloper.replace("{name}", item.author) } : undefined}
      badge={item.enabled ? undefined : t.badgeDisabled}
    />
  );
  return (
    <YourRow
      logo={
        <PluginLogo
          name={item.name}
          hints={`${item.category ?? ""} ${item.keywords.join(" ")} ${skill ? "skill" : ""} ${item.description.slice(0, 120)}`}
          size={28}
          className={cn(!item.enabled && "opacity-50 grayscale")}
        />
      }
      name={item.name}
      verified={!!item.verified}
      meta={meta}
      onOpen={skill ? undefined : () => onOpen(item)}
      right={
        <>
          {actions.notice ? (
            <span className="text-[13px] text-green-500">{actions.notice}</span>
          ) : item.update && (
            <button type="button" onClick={() => void actions.update()} className="h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-100 hover:bg-bg-300">
              {t.update}
            </button>
          )}
          <PluginMenu item={item} actions={actions} />
          {actions.dialogs}
        </>
      }
    />
  );
}

/** A category's icon, from the words of its name (catalogs name them in their own language). */
const CATEGORY_ICONS: [RegExp, LucideIcon][] = [
  [/c[oó]digo|code|develop|desarroll|ingenier|engineer/i, CodeXml],
  [/api/i, Braces],
  [/datos|data|base/i, Database],
  [/dise[ñn]o|design|media|medios/i, Palette],
  [/archivo|document|file/i, FileText],
  [/correo|mensaje|mail|messag|comunica/i, Mail],
  [/automati|flujo|workflow/i, Workflow],
  [/financ|finanz|pago|payment/i, CircleDollarSign],
  [/productiv|tarea|task|ticket/i, ListChecks],
  [/soporte|support/i, Headphones],
  [/estado|status|monitor|registro|log/i, ChartLine],
  [/marketing|ventas|sales/i, Megaphone],
  [/segur|secur/i, Shield],
  [/test|prueba/i, FlaskConical],
  [/nube|cloud|servidor|server|infra/i, Cloud],
  [/web|sitio|site/i, Globe],
  [/ia\b|ai\b|agente|agent|model/i, Sparkles],
];

function categoryIcon(name: string): LucideIcon {
  return CATEGORY_ICONS.find(([re]) => re.test(name))?.[1] ?? Tag;
}

/** A plugin catalog's category ("development") as a title ("Development"). */
const prettyCategory = (c: string) => capitalize(c.replace(/[-_]+/g, " "));

/**
 * The page under the toolbar, as Claude's Plugins page: the user's own plugins, connectors and
 * skills, then the directory in sections (most used, popular workflows, trending, new), the
 * categories, and a card to build one. A search or a filter lists what matches instead, and a
 * section's "Show all" opens its whole list.
 */
export function PluginsHome({
  scope,
  query,
  filter,
  onClearFilter,
  view,
  onView,
  connectors,
  items,
  catalog,
  marketplaces,
  onOpenConnector,
  onOpenPlugin,
  onOpenCatalogPlugin,
  onStartChat,
  error,
  onError,
}: {
  scope: Scope;
  query: string;
  filter: ConnectorFilter;
  onClearFilter: () => void;
  view: HomeView;
  onView: (v: HomeView) => void;
  connectors: Connectors;
  items: PluginItem[] | null;
  catalog: CatalogEntry[] | null;
  marketplaces: KnownMarketplace[];
  onOpenConnector: (entry: ConnectorCatalogEntry) => void;
  onOpenPlugin: (item: PluginItem) => void;
  onOpenCatalogPlugin: (entry: CatalogEntry) => void;
  onStartChat?: (title: string, prompt: string) => void;
  error: string | null;
  onError: (msg: string | null) => void;
}) {
  const tr = useTranslations();
  const t = tr.customizePage;
  const [confirm, confirmElement] = useConfirm();
  const withConnectors = scope !== "skills";
  const withPlugins = scope !== "connectors";

  const installedOf = (e: CatalogEntry) =>
    items?.find((it) => it.kind === "plugin" && it.installed?.marketplace === e.marketplace && it.installed.plugin === e.name);
  const connectorEntry = (c: ConnectorCatalogEntry): DirEntry => {
    const linked = !!connectors.serverFor(c)?.enabled;
    // One that needs the user's own OAuth client asks for it on its page.
    const needsClient = !!c.oauthManualClient && !c.oauthClientId?.trim() && !connectors.serverFor(c);
    return {
      key: `c:${c.url}`,
      name: c.name,
      description: c.description,
      verified: isVerified(c),
      logo: (size) => <ConnectorLogo entry={c} size={size} />,
      kind: t.connectorKind,
      by: c.developer ? { text: t.byDeveloper.replace("{name}", c.developer) } : undefined,
      open: () => onOpenConnector(c),
      add: linked ? undefined : () => (needsClient ? onOpenConnector(c) : void connectors.connect(c, undefined, t.missingClientId)),
      addLabel: t.connect,
      adding: connectors.opening === c.name,
    };
  };
  const pluginEntry = (e: CatalogEntry): DirEntry => {
    const mine = installedOf(e);
    const src = mine?.source ?? sourceOf(null, e.homepage, marketplaces.find((m) => m.name === e.marketplace));
    return {
      key: `p:${e.marketplace}/${e.name}`,
      name: e.name,
      description: e.description,
      verified: isBuiltinMarketplace(e.marketplace),
      logo: (size) => <PluginLogo name={e.name} hints={`${e.category ?? ""} ${e.keywords.join(" ")} ${e.description.slice(0, 120)}`} size={size} />,
      kind: partsLine(mine?.parts, t) || t.pluginKind,
      by: src ? { text: src.label, github: true } : e.author ? { text: t.byDeveloper.replace("{name}", e.author) } : undefined,
      open: () => (mine ? onOpenPlugin(mine) : onOpenCatalogPlugin(e)),
      add: mine ? undefined : () => void install(e),
      addLabel: t.install,
    };
  };

  /** "+" on a plugin: installs it once the user agrees, as its page's Install does. */
  const install = async (e: CatalogEntry) => {
    const ok = await confirm({
      title: t.installPluginTitle.replace("{name}", e.name),
      message: tr.pluginsPanel.trustWarning,
      confirmLabel: tr.pluginsPanel.install,
      cancelLabel: tr.pluginsPanel.cancel,
    });
    if (!ok) return;
    onError(null);
    try {
      await installPlugin(e.marketplace, e.name, { enable: true });
      notifyPluginsChanged();
    } catch (err) {
      onError(`${e.name}: ${localizedError(err)}`);
    }
  };

  // The user's own, connectors first as in Claude's list.
  const yours: { key: string; name: string; node: ReactNode }[] = [
    ...(withConnectors
      ? [
          ...connectors.servers.map((s) => ({
            key: `s:${s.id}`,
            name: s.name,
            node: <YourConnector key={`s:${s.id}`} server={s} connectors={connectors} onOpen={onOpenConnector} />,
          })),
          ...connectors.configServers.map((s) => ({
            key: `cs:${s.id}`,
            name: s.name,
            node: <YourConnector key={`cs:${s.id}`} server={s} connectors={connectors} readOnly onOpen={onOpenConnector} />,
          })),
        ]
      : []),
    ...(withPlugins
      ? (items ?? []).map((it) => ({
          key: it.key,
          name: it.name,
          node: <YourPlugin key={it.key} item={it} onError={onError} onOpen={onOpenPlugin} />,
        }))
      : []),
  ];

  const popular = byPopularity(CONNECTOR_CATALOG);
  const sections: Record<SectionId, { title: string; entries: DirEntry[]; shown: number }> = {
    yours: { title: t.yourPlugins, entries: [], shown: YOURS_SHOWN },
    mostUsed: { title: t.mostUsed, entries: withConnectors ? popular.map(connectorEntry) : [], shown: 12 },
    // Anthropic's marketplace first: its plugins are the reviewed workflows.
    workflows: {
      title: t.popularWorkflows,
      entries: withPlugins
        ? [...(catalog ?? [])]
            .sort((a, b) => Number(isBuiltinMarketplace(b.marketplace)) - Number(isBuiltinMarketplace(a.marketplace)))
            .map(pluginEntry)
        : [],
      shown: 8,
    },
    trending: { title: t.trendingTitle, entries: withConnectors ? popular.filter((c) => c.trending).map(connectorEntry) : [], shown: 6 },
    new: {
      title: t.whatsNew,
      entries: withConnectors
        ? CONNECTOR_CATALOG.filter(isNewConnector)
            .sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""))
            .map(connectorEntry)
        : [],
      shown: 6,
    },
  };

  const categories = [
    ...(withConnectors ? connectorCategories().map((c) => c.name) : []),
    ...(withPlugins ? [...new Set((catalog ?? []).map((e) => e.category).filter((c): c is string => !!c))].map(prettyCategory) : []),
  ].filter((c, i, all) => all.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i)
    .sort((a, b) => a.localeCompare(b, getLanguage()));
  const inCategory = (name: string): DirEntry[] => [
    ...(withConnectors ? popular.filter((c) => c.category?.toLowerCase() === name.toLowerCase()).map(connectorEntry) : []),
    ...(withPlugins ? (catalog ?? []).filter((e) => e.category && prettyCategory(e.category).toLowerCase() === name.toLowerCase()).map(pluginEntry) : []),
  ];

  const errorLines = (
    <>
      {error && <p className="text-[13px] text-red-400 mb-4 break-words">{error}</p>}
      {connectors.error && <p className="text-[13px] text-red-400 mb-4 break-words">{connectors.error}</p>}
    </>
  );

  const back = (
    <button type="button" onClick={() => onView(null)} className="inline-flex items-center gap-1.5 text-[14px] text-text-200 hover:text-text-100 mb-5">
      <ArrowLeft className="w-4 h-4" />
      {t.plugins}
    </button>
  );

  // A search, or a filter from the toolbar: what matches, in one list.
  const q = query.trim().toLowerCase();
  const filtering = filter.category !== null || filter.kind !== "all";
  if (q || filtering) {
    const matches = (s: string | undefined) => !!s && s.toLowerCase().includes(q);
    const results: DirEntry[] = [
      ...(withConnectors ? filterConnectors(query, filter).map(connectorEntry) : []),
      ...(withPlugins && !filtering
        ? (catalog ?? []).filter((e) => matches(e.name) || matches(e.description) || matches(e.category) || e.keywords.some(matches)).map(pluginEntry)
        : []),
    ];
    const yoursFound = q ? yours.filter((y) => y.name.toLowerCase().includes(q)) : [];
    return (
      <div className="pb-16">
        {confirmElement}
        {errorLines}
        {yoursFound.length > 0 && (
          <section className="mb-10">
            <SectionHead title={t.yourPlugins} />
            {yoursFound.map((y) => y.node)}
          </section>
        )}
        <div className="flex items-center mb-2">
          <h2 className="text-[15px] font-medium text-text-100">{filter.category ?? t.results}</h2>
          {filtering && (
            <button type="button" onClick={onClearFilter} className="ml-auto text-[13px] text-text-300 hover:text-text-100">
              {t.clearFilters}
            </button>
          )}
        </div>
        {results.length ? <EntryGrid entries={results} /> : <p className="py-8 text-[13px] text-text-400">{t.noResults}</p>}
      </div>
    );
  }

  if (view) {
    const title = view.kind === "category" ? view.name : sections[view.id].title;
    return (
      <div className="pb-16">
        {confirmElement}
        {back}
        {errorLines}
        <SectionHead title={title} />
        {view.kind === "section" && view.id === "yours" ? (
          yours.map((y) => y.node)
        ) : (
          <EntryGrid entries={view.kind === "category" ? inCategory(view.name) : sections[view.id].entries} />
        )}
      </div>
    );
  }

  const hidden = yours.slice(YOURS_SHOWN);
  const restLine =
    hidden.length > 0
      ? new Intl.ListFormat(getLanguage(), { type: "conjunction" }).format([
          ...hidden.slice(0, 3).map((y) => y.name),
          ...(hidden.length > 3 ? [t.nMore.replace("{n}", String(hidden.length - 3))] : []),
        ])
      : "";

  return (
    <div className="pb-16">
      {errorLines}
      {items === null && withPlugins && (
        <div className="flex items-center gap-2 py-6 text-[13px] text-text-400">
          <Loader2 className="w-4 h-4 animate-spin" /> {t.loading}
        </div>
      )}
      {yours.length > 0 && (
        <section className="mb-10">
          <SectionHead title={t.yourPlugins} onShowAll={() => onView({ kind: "section", id: "yours" })} />
          {yours.slice(0, YOURS_SHOWN).map((y) => y.node)}
          {restLine && (
            <button
              type="button"
              onClick={() => onView({ kind: "section", id: "yours" })}
              className="block pl-10 pt-4 text-left text-[13px] text-text-400 hover:text-text-200"
            >
              {restLine}
            </button>
          )}
        </section>
      )}

      {(["mostUsed", "workflows", "trending", "new"] as SectionId[]).map((id) => {
        const s = sections[id];
        if (!s.entries.length) return null;
        return (
          <section key={id} className="mb-10">
            <SectionHead title={s.title} onShowAll={() => onView({ kind: "section", id })} />
            <EntryGrid entries={s.entries.slice(0, s.shown)} />
          </section>
        );
      })}

      {categories.length > 0 && (
        <section className="mb-12">
          <SectionHead title={t.categories} />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6">
            {categories.map((c) => {
              const Icon = categoryIcon(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onView({ kind: "category", name: c })}
                  className="flex items-center gap-2.5 h-8 min-w-0 text-left text-[14px] text-text-100 hover:text-text-200"
                >
                  <Icon className="w-4 h-4 shrink-0 text-text-400" strokeWidth={1.75} />
                  <span className="truncate">{c}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="rounded-[8px] bg-bg-200/60 px-6 py-5">
        <p className="text-[15px] font-medium text-text-100">{t.buildTitle}</p>
        <p className="text-[14px] text-text-300 mt-1.5">{t.buildText}</p>
        <div className="flex items-center gap-3 mt-4">
          <a
            href={DOCS_URL}
            onClick={handleExternalLinkClick}
            rel="noreferrer"
            className="inline-flex items-center gap-1 h-8 px-3 rounded-[6px] bg-bg-300/70 text-[14px] text-text-100 hover:bg-bg-300"
          >
            {t.devDocs}
            <ArrowUpRight className="w-4 h-4" />
          </a>
          {onStartChat && (
            <button
              type="button"
              onClick={() => onStartChat(t.createPluginTitle, t.createPluginPrompt)}
              className="h-8 px-3 rounded-[6px] bg-text-100 text-bg-0 text-[14px] font-medium hover:opacity-90"
            >
              {t.createWithNyxs}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

