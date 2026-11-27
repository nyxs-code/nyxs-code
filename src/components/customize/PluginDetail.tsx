import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, BadgeCheck, Bot, Check, CodeXml, Loader2, Palette, ScrollText, Server, SquareSlash, type LucideIcon } from "lucide-react";
import { invoke } from "@/lib/ipc";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { getLanguage, localizedError, useTranslations } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import { installPlugin, isBuiltinMarketplace, refreshMarketplace, type KnownMarketplace } from "@/lib/plugins";
import { networkHosts, runsCode, shownVersion, sourceOf, type PluginPart, type PluginParts } from "@/lib/plugins/pluginDetails";
import { cn } from "@/lib/utils";
import { GithubMark, PluginLogo } from "./logos";
import { FILES_BOTTOM_GAP, PluginFiles } from "./PluginFiles";
import { PluginMenu } from "./PluginMenu";
import { partsLine } from "./pluginText";
import { usePluginActions } from "./usePluginActions";
import type { CatalogEntry } from "./usePluginCatalog";
import { notifyPluginsChanged, type PluginItem } from "./usePluginsData";

/** Which plugin a page shows: its marketplace and its name there. */
export interface PluginTarget {
  marketplace: string;
  name: string;
}

type Entry = CatalogEntry;

const DAY = 86_400_000;
const RELATED = 6;
/** A marketplace is read again at most this often when its plugins' pages open. */
const RECHECK_MS = 10 * 60_000;
const lastChecked = new Map<string, number>();

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[13px] text-text-400 mb-1">{label}</p>
      {children}
    </div>
  );
}

/** One kind of thing the plugin adds, as a card of rows: a hook and what it may do, a command
 *  and what it's for… */
function PartsCard({ title, icon: Icon, rows, mono }: {
  title: string;
  icon: LucideIcon;
  rows: { name: string; detail?: string }[];
  mono?: boolean;
}) {
  if (!rows.length) return null;
  return (
    <section className="mt-8">
      <h2 className="text-[15px] font-medium text-text-100 mb-3">{title}</h2>
      <div className="rounded-[8px] bg-bg-200/60 divide-y divide-bg-300/70">
        {rows.map((r, i) => (
          <div key={`${r.name}-${i}`} className="flex items-center gap-3 px-4 py-2.5 min-w-0">
            <Icon className="w-4 h-4 shrink-0 text-text-400" />

            <span className={cn("shrink-0 max-w-[45%] truncate text-[14px] text-text-100", mono && "font-mono text-[13px]")}>{r.name}</span>
            {r.detail && <span className="flex-1 min-w-0 truncate text-[14px] text-text-400 pl-4">{r.detail}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Underlined tabs: Summary · Files. */
function Tabs<T extends string>({ value, onChange, items }: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: string }[];
}) {
  return (
    <div role="tablist" className="flex items-center gap-1 border-b border-bg-300 mt-6">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={cn(
            "relative h-9 px-3 text-[14px] transition-colors",
            value === it.id ? "text-text-100" : "text-text-300 hover:text-text-100",
          )}
        >
          {it.label}
          {value === it.id && <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-text-100" />}
        </button>
      ))}
    </div>
  );
}

/** The actions of an installed plugin: Added (or Turned off), its menu, and Update. */
function InstalledActions({ item, onError, onRemoved, checking }: {
  item: PluginItem;
  onError: (msg: string | null) => void;
  onRemoved: () => void;
  /** Its marketplace is being read again for a newer version. */
  checking: boolean;
}) {
  const t = useTranslations().customizePage;
  const actions = usePluginActions(item, onError);
  const update = item.update;
  return (
    <div className="flex items-center gap-2 shrink-0">
      {actions.notice ? (
        <span className="inline-flex items-center gap-1 text-[13px] text-green-500">
          <Check className="w-3.5 h-3.5" />
          {actions.notice}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-200">
          {item.enabled && <Check className="w-4 h-4" />}
          {item.enabled ? t.added : t.badgeDisabled}
        </span>
      )}
      <PluginMenu item={item} actions={actions} withFolder onRemoved={onRemoved} />
      <button
        type="button"
        onClick={() => void actions.update()}
        disabled={!update || actions.busy || checking}
        className={cn(
          "inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] text-[14px] transition-opacity",
          update ? "bg-text-100 text-bg-0 font-medium hover:opacity-90" : "bg-bg-200 text-text-400",
        )}
      >
        {(checking || actions.busy) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {update?.kind === "version" ? t.updateTo.replace("{version}", update.latest) : t.update}
      </button>
      {actions.dialogs}
    </div>
  );
}

/**
 * A plugin's page, laid out like Claude's: who publishes it and what it does on top, a summary
 * of what it adds (hooks, commands, agents, skills, MCP servers) with its facts on the side, its
 * files, and related plugins below. A plugin that isn't installed yet shows what its marketplace
 * says of it, with Install.
 */
export function PluginDetail({
  target,
  items,
  catalog,
  known,
  onBack,
  onOpen,
  backLabel,
  onError,
}: {
  target: PluginTarget;
  items: PluginItem[] | null;
  /** Every marketplace's catalog: the entry of a plugin not installed yet, and related plugins. */
  catalog: Entry[] | null;
  known: KnownMarketplace[];
  onBack: () => void;
  onOpen: (target: PluginTarget) => void;
  backLabel: string;
  onError: (msg: string | null) => void;
}) {
  const tr = useTranslations();
  const t = tr.customizePage;
  const [tab, setTab] = useState<"summary" | "files">("summary");
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();
  const [now] = useState(() => Date.now());

  const item = items?.find(
    (it) => it.kind === "plugin" && it.installed?.marketplace === target.marketplace && it.installed.plugin === target.name,
  );

  // Opening an installed plugin reads its marketplace again, so a newer version shows on Update
  // (as Claude's page does) without waiting for the user to check by hand. Nothing installs here.
  const installedHere = !!item?.installed;
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const mp = target.marketplace;
    if (!installedHere || Date.now() - (lastChecked.get(mp) ?? 0) < RECHECK_MS) return;
    lastChecked.set(mp, Date.now());
    let alive = true;
    void Promise.resolve()
      .then(() => setChecking(true))
      .then(() => refreshMarketplace(mp))
      .then(() => notifyPluginsChanged())
      .catch(() => undefined)
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [installedHere, target.marketplace]);
  const entry = item?.catalog ?? catalog?.find((e) => e.marketplace === target.marketplace && e.name === target.name);
  const marketplace = known.find((m) => m.name === target.marketplace);

  if (!item && !entry) {
    return (
      <div className="max-w-[960px] mx-auto pb-16">
        <BackButton label={backLabel} onBack={onBack} />
        <div className="flex items-center gap-2 py-16 justify-center text-[13px] text-text-400">
          {catalog === null || items === null ? <><Loader2 className="w-4 h-4 animate-spin" /> {t.loading}</> : t.noResults}
        </div>
      </div>
    );
  }

  const name = item?.name ?? entry!.name;
  const description = item?.manifest?.description || entry?.description || item?.description || "";
  const verified = isBuiltinMarketplace(target.marketplace);
  const isNew = item?.installedAt !== undefined && now - item.installedAt < 3 * DAY;
  const source = item?.source ?? sourceOf(null, entry?.homepage, marketplace);
  const marketplaceSource = sourceOf(null, undefined, marketplace);
  const parts: PluginParts | undefined = item?.parts;
  const author = item?.author ?? entry?.author;
  const category = item?.category ?? entry?.category;
  const version = item?.installed
    ? shownVersion(item.manifest, item.installed.version, item.installed.sha)
    : shownVersion(null, entry?.version);
  const license = item?.manifest?.license;
  const installedDate = item?.installedAt
    ? new Date(item.installedAt).toLocaleDateString(getLanguage(), { day: "numeric", month: "short" })
    : null;
  const hosts = parts ? networkHosts(parts) : [];
  const security = parts
    ? [
        ...(runsCode(parts) ? [t.canRunCode] : []),
        ...hosts.map((h) => t.canSendDataTo.replace("{host}", h)),
      ]
    : [];
  const hooks: PluginPart[] = parts?.hooks.map((h) => ({ name: h.name, detail: t.canRunCode })) ?? [];
  const servers = parts?.mcpServers.map((s) => ({
    name: s.name,
    detail: s.host ? t.canSendDataTo.replace("{host}", s.host) : t.runsOnComputer,
  })) ?? [];

  const install = async () => {
    if (!entry) return;
    const ok = await confirm({
      title: t.installPluginTitle.replace("{name}", entry.name),
      message: tr.pluginsPanel.trustWarning,
      confirmLabel: tr.pluginsPanel.install,
      cancelLabel: tr.pluginsPanel.cancel,
    });
    if (!ok) return;
    setInstalling(true);
    setError(null);
    try {
      await installPlugin(target.marketplace, entry.name, { enable: true });
      notifyPluginsChanged();
    } catch (e) {
      setError(localizedError(e));
    } finally {
      setInstalling(false);
    }
  };

  const related = relatedOf(catalog ?? [], target, category);
  const installedItem = (e: Entry) =>
    items?.find((it) => it.kind === "plugin" && it.installed?.marketplace === e.marketplace && it.installed.plugin === e.name);

  const filesShown = tab === "files" && !!item?.installed;

  return (
    <div className="max-w-[960px] mx-auto" style={{ paddingBottom: filesShown ? FILES_BOTTOM_GAP : 64 }}>
      <BackButton label={backLabel} onBack={onBack} />

      <div className="flex items-center gap-4">
        <PluginLogo name={name} hints={`${category ?? ""} ${description.slice(0, 120)}`} size={44} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-[22px] leading-tight text-text-100 truncate">{name}</h1>
            {verified && <BadgeCheck className="w-5 h-5 shrink-0 text-text-400" aria-label={t.verified} strokeWidth={1.75} />}
            {isNew && (
              <span className="shrink-0 inline-flex items-center h-[18px] px-1.5 rounded-[5px] text-[11px] bg-blue-500/10 text-blue-500 font-medium">
                {t.badgeNew}
              </span>
            )}
          </div>
          <p className="text-[14px] text-text-400 mt-0.5 truncate">
            {marketplaceSource?.label ?? target.marketplace}
            {description && <span className="mx-1.5">·</span>}
            {description}
          </p>
        </div>
        {item ? (
          <InstalledActions item={item} onError={onError} onRemoved={onBack} checking={checking} />
        ) : (
          <button
            type="button"
            onClick={() => void install()}
            disabled={installing}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] bg-text-100 text-bg-0 text-[14px] font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {installing && <Loader2 className="w-4 h-4 animate-spin" />}
            {installing ? t.installing : t.install}
          </button>
        )}
      </div>
      {error && <p className="text-[13px] text-red-400 mt-4 break-words">{error}</p>}

      {item?.installed && (
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { id: "summary", label: t.summary },
            { id: "files", label: fileCount === null ? t.files : `${t.files} · ${fileCount}` },
          ]}
        />
      )}

      {filesShown && item?.installed ? (
        <div className="pt-6">
          <PluginFiles
            root={item.installed.installLocation}
            title={[name, version].filter(Boolean).join(" ")}
            installedAt={item.installedAt}
            onCount={setFileCount}
            onOpenFolder={() => void invoke("agent_open_path", { path: item.installed!.installLocation }).catch(() => undefined)}
          />
        </div>
      ) : (
        <div className={cn("grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_260px] gap-x-10 gap-y-8 pt-7", !item?.installed && "border-t border-bg-300 mt-7")}>
          <div className="min-w-0">
            <p className="text-[14px] text-text-100 leading-relaxed whitespace-pre-line">{description || tr.pluginsPanel.noDescription}</p>
            <PartsCard title={t.hooks} icon={CodeXml} rows={hooks} mono />
            <PartsCard title={t.commands} icon={SquareSlash} rows={parts?.commands ?? []} mono />
            <PartsCard title={t.agents} icon={Bot} rows={parts?.agents ?? []} />
            <PartsCard title={t.skills} icon={ScrollText} rows={parts?.skills ?? []} />
            <PartsCard title={t.mcpServers} icon={Server} rows={servers} />
            <PartsCard title={t.outputStyles} icon={Palette} rows={parts?.outputStyles ?? []} />
          </div>

          <aside className="space-y-5">
            {verified && (
              <Fact label={t.developerLevel}>
                <span className="inline-flex items-center gap-1 h-6 px-2 rounded-[6px] bg-blue-500/10 text-[12px] font-medium text-blue-500">
                  <BadgeCheck className="w-3.5 h-3.5" />
                  {t.verified}
                </span>
                <p className="text-[13px] text-text-400 mt-1.5">{t.officialMarketplace}</p>
              </Fact>
            )}
            {author && (
              <Fact label={t.developer}>
                <p className="text-[14px] text-text-100 break-words">{author}</p>
              </Fact>
            )}
            {parts && (
              <Fact label={t.securityAccess}>
                {(security.length ? security : [t.noCodeNoNetwork]).map((s) => (
                  <p key={s} className="text-[14px] text-text-100 break-words">{s}</p>
                ))}
              </Fact>
            )}
            {source && (
              <Fact label={t.sourceCode}>
                {source.url ? (
                  <a
                    href={source.url}
                    onClick={handleExternalLinkClick}
                    rel="noreferrer"
                    className="inline text-[14px] text-[color:var(--link)] underline underline-offset-2 hover:opacity-80 break-all"
                  >
                    {source.url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "")}
                    <ArrowUpRight className="inline w-3.5 h-3.5 ml-0.5 -mt-0.5" />
                  </a>
                ) : (
                  <p className="text-[14px] text-text-100 break-all">{source.label}</p>
                )}
              </Fact>
            )}
            {category && (
              <Fact label={t.category}>
                <span className="inline-flex h-7 items-center px-2.5 rounded-[6px] bg-bg-200 text-[13px] text-text-100">{category}</span>
              </Fact>
            )}
            {version && (
              <Fact label={t.version}>
                <p className="text-[14px] text-text-100">
                  {version}
                  {installedDate && <span className="text-text-400"> ({t.installedOn.replace("{date}", installedDate)})</span>}
                </p>
              </Fact>
            )}
            {license && (
              <Fact label={t.license}>
                <p className="text-[14px] text-text-100">{license}</p>
              </Fact>
            )}
          </aside>
        </div>
      )}

      {tab === "summary" && related.length > 0 && (
        <div className="border-t border-bg-300 mt-10 pt-8">
          <h2 className="text-[15px] font-medium text-text-100 mb-2">{t.relatedPlugins}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10">
            {related.map((e) => {
              const mine = installedItem(e);
              const src = mine?.source ?? sourceOf(null, e.homepage, known.find((m) => m.name === e.marketplace));
              return (
                <button
                  key={`${e.marketplace}/${e.name}`}
                  type="button"
                  onClick={() => onOpen({ marketplace: e.marketplace, name: e.name })}
                  className="flex items-start gap-3 py-3.5 border-b border-bg-300 text-left outline-none focus-visible:bg-bg-200/50"
                >
                  <PluginLogo name={e.name} hints={`${e.category ?? ""} ${e.keywords.join(" ")} ${e.description.slice(0, 120)}`} size={28} />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[14px] font-medium text-text-100 truncate">{e.name}</span>
                      {isBuiltinMarketplace(e.marketplace) && (
                        <BadgeCheck className="w-4 h-4 shrink-0 text-text-400" aria-label={t.verified} strokeWidth={1.75} />
                      )}
                    </span>
                    <span className="block text-[13px] text-text-300 leading-snug mt-0.5 truncate">{e.description}</span>
                    <span className="flex items-center gap-1 text-[13px] text-text-400 mt-0.5 min-w-0">
                      <span className="shrink-0">{partsLine(mine?.parts, t) || t.pluginKind}</span>
                      {src && (
                        <>
                          <span className="mx-0.5 shrink-0">·</span>
                          <GithubMark className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{src.label}</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {confirmElement}
    </div>
  );
}

function BackButton({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex items-center gap-1.5 text-[14px] text-text-200 hover:text-text-100 mb-5"
    >
      <ArrowLeft className="w-4 h-4" />
      {label}
    </button>
  );
}

/** Plugins in the same category first, then from the same marketplace; never the plugin itself. */
function relatedOf(catalog: Entry[], target: PluginTarget, category: string | undefined): Entry[] {
  const others = catalog.filter((e) => !(e.marketplace === target.marketplace && e.name === target.name));
  const same = category ? others.filter((e) => e.category === category) : [];
  const near = others.filter((e) => e.marketplace === target.marketplace && !same.includes(e));
  const seen = new Set<string>();
  return [...same, ...near]
    .filter((e) => {
      const key = `${e.marketplace}/${e.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, RELATED);
}
