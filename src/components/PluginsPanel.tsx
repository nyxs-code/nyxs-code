import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search, Trash2, RefreshCw, Loader2, Package, Store, ChevronRight,
  Check, ArrowLeft, ShieldAlert, Download, ArrowUpCircle,
} from "lucide-react";
import { localizedError, useTranslations } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import {
  listMarketplaces, removeMarketplace, setAutoUpdate, describeSource,
  ensureDefaultMarketplaces, isBuiltinMarketplace,
  getCatalog, refreshAllMarketplaces,
  listInstalled, installPlugin, uninstallPlugin, isEnabled, setEnabled,
  checkPluginUpdates, updatePlugin,
  type KnownMarketplace, type CatalogPlugin, type InstalledPlugin, type PluginUpdate,
} from "@/lib/plugins";

type MarketplaceRow = KnownMarketplace & { fromSettings?: boolean; builtin?: boolean };

export function PluginsPanel() {
  const t = useTranslations().pluginsPanel;
  const [view, setView] = useState<{ kind: "list" } | { kind: "browse"; marketplace: string }>({ kind: "list" });
  const [marketplaces, setMarketplaces] = useState<MarketplaceRow[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [updates, setUpdates] = useState<PluginUpdate[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      await ensureDefaultMarketplaces();
      const mps = await listMarketplaces();
      setMarketplaces(mps);
      setError(null);
    } catch (e) {
      setError(`Could not load marketplaces: ${e instanceof Error ? e.message : String(e)}`);
      setMarketplaces([]);
    }
    try {
      const inst = await listInstalled();
      setInstalled(inst);
      const flags = await Promise.all(inst.map((p) => isEnabled(p.id)));
      setEnabledIds(new Set(inst.filter((_, i) => flags[i]).map((p) => p.id)));
    } catch {
      setInstalled([]);
      setEnabledIds(new Set());
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(reload);
    checkPluginUpdates().then(setUpdates).catch(() => undefined);
  }, [reload]);

  const refreshAll = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const { failed } = await refreshAllMarketplaces();
      if (failed.length) setError(`Failed to refresh: ${failed.map((f) => f.name).join(", ")}`);
      setUpdates(await checkPluginUpdates());
      await reload();
    } catch (e) {
      setError(localizedError(e));
    } finally {
      setRefreshing(false);
    }
  };

  if (view.kind === "browse") {
    return (
      <BrowseMarketplace
        marketplace={view.marketplace}
        installed={installed}
        onBack={() => setView({ kind: "list" })}
        onChanged={reload}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-semibold text-text-100">{t.heading}</h2>
          <button
            onClick={refreshAll}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-bg-300 text-text-200 hover:bg-bg-200 disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {t.refresh}
          </button>
        </div>
        <p className="text-sm text-text-400 mb-4">
          {t.intro}
        </p>
        {error && <p className="text-[12px] text-red-400 mb-3 break-words">{error}</p>}

        <MarketplaceList
          marketplaces={marketplaces}
          onBrowse={(name) => setView({ kind: "browse", marketplace: name })}
          onChanged={reload}
        />
      </div>

      <InstalledList
        installed={installed}
        enabledIds={enabledIds}
        updates={updates}
        onChanged={async () => {
          await reload();
          setUpdates(await checkPluginUpdates().catch(() => []));
        }}
        onError={setError}
      />
    </div>
  );
}

function MarketplaceList({
  marketplaces, onBrowse, onChanged,
}: {
  marketplaces: MarketplaceRow[];
  onBrowse: (name: string) => void;
  onChanged: () => void;
}) {
  const t = useTranslations().pluginsPanel;
  if (marketplaces.length === 0) {
    return (
      <div className="rounded-[8px] border border-dashed border-bg-300 p-6 text-center">
        <Store className="w-6 h-6 text-text-400 mx-auto mb-2" />
        <p className="text-sm text-text-300">{t.noMarketplaces}</p>
        <p className="text-[12px] text-text-500 mt-1">{t.noMarketplacesHint}</p>
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {marketplaces.map((m) => {
        const builtin = m.builtin ?? isBuiltinMarketplace(m.name);
        const srcLabel = m.source ? describeSource(m.source) : "";
        return (
        <li key={m.name} className="flex items-center gap-3 px-3 py-2.5 rounded-[8px] border border-bg-300 bg-bg-100">
          <Store className="w-4 h-4 text-text-400 shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2 text-[13px] font-medium text-text-100">
              {m.name}
              {builtin && (
                <span className="px-1.5 py-0.5 rounded text-[9px] uppercase bg-bg-300 text-text-400">git</span>
              )}
              {m.fromSettings && (
                <span className="px-1.5 py-0.5 rounded text-[9px] uppercase bg-bg-300 text-text-400">settings</span>
              )}
            </span>
            {srcLabel && (
              <span className="block text-[11px] text-text-400 font-mono truncate">{srcLabel}</span>
            )}
          </span>
          <label className="flex items-center gap-1.5 text-[11px] text-text-400 shrink-0" data-tooltip={t.autoRefreshTitle}>
            <input
              type="checkbox"
              checked={m.autoUpdate}
              disabled={m.fromSettings || builtin}
              onChange={async (e) => { await setAutoUpdate(m.name, e.target.checked); onChanged(); }}
              className="accent-accent"
            />
            {t.auto}
          </label>
          <button
            onClick={() => onBrowse(m.name)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium border border-bg-300 text-text-200 hover:bg-bg-200 shrink-0"
          >
            {t.browse} <ChevronRight className="w-3.5 h-3.5" />
          </button>
          {!m.fromSettings && !builtin && (
            <button
              onClick={async () => { await removeMarketplace(m.name); onChanged(); }}
              className="p-1 rounded text-text-400 hover:text-red-400 shrink-0"
              aria-label={t.removeMarketplace}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </li>
        );
      })}
    </ul>
  );
}

function BrowseMarketplace({
  marketplace, installed, onBack, onChanged,
}: {
  marketplace: string;
  installed: InstalledPlugin[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations().pluginsPanel;
  const [plugins, setPlugins] = useState<CatalogPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const installedHere = useMemo(
    () => new Set(installed.filter((p) => p.marketplace === marketplace).map((p) => p.plugin)),
    [installed, marketplace],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlugins(null);
    setError(null);
    getCatalog(marketplace)
      .then((c) => setPlugins(c.plugins))
      .catch((e) => setError(localizedError(e)));
  }, [marketplace]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of plugins ?? []) if (p.category) set.add(p.category);
    return [...set].sort();
  }, [plugins]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (plugins ?? []).filter((p) => {
      if (category && p.category !== category) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.description} ${p.keywords.join(" ")} ${p.author ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [plugins, query, category]);

  const doInstall = async (plugin: CatalogPlugin) => {
    setBusy(plugin.name);
    setError(null);
    try {
      await installPlugin(marketplace, plugin.name, { enable: true });
      setConfirming(null);
      onChanged();
    } catch (e) {
      setError(localizedError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button onClick={onBack} className="p-1.5 rounded-md text-text-300 hover:text-text-100 hover:bg-bg-200" aria-label="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h2 className="text-xl font-semibold text-text-100 flex items-center gap-2">
          <Store className="w-4 h-4 text-text-400" /> {marketplace}
        </h2>
      </div>

      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.searchPlaceholder}
          className="w-full pl-9 pr-3 py-2 text-sm rounded-[8px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent"
        />
      </div>

      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <FilterChip label={t.all} active={!category} onClick={() => setCategory(null)} />
          {categories.map((c) => (
            <FilterChip key={c} label={c} active={category === c} onClick={() => setCategory(c)} />
          ))}
        </div>
      )}

      {error && <p className="text-[12px] text-red-400 mb-3 break-words">{error}</p>}

      {plugins === null && !error ? (
        <div className="flex items-center gap-2 text-sm text-text-400 py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> {t.loadingCatalog}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-text-500 italic py-6 text-center">{t.noPluginsMatch}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filtered.map((p) => {
            const here = installedHere.has(p.name);
            const isConfirming = confirming === p.name;
            return (
              <div key={p.name} className="rounded-[8px] border border-bg-300 bg-bg-100 p-3 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-text-100 min-w-0">
                    <Package className="w-3.5 h-3.5 text-text-400 shrink-0" />
                    <span className="truncate">{p.name}</span>
                    <span className="text-[10px] text-text-500 font-mono shrink-0">v{p.version}</span>
                  </span>
                  {here ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-green-400 shrink-0">
                      <Check className="w-3.5 h-3.5" /> {t.installed}
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirming(p.name)}
                      disabled={busy === p.name}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border border-bg-300 text-text-200 hover:bg-bg-200 disabled:opacity-50 shrink-0"
                    >
                      {busy === p.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      {t.install}
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-text-400 leading-snug">{p.description || t.noDescription}</p>
                <div className="flex items-center gap-2 text-[10px] text-text-500">
                  {p.author && <span>by {p.author}</span>}
                  {p.category && <span className="uppercase tracking-wide">{p.category}</span>}
                </div>
                {isConfirming && (
                  <div className="mt-1 rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-2 space-y-2">
                    <p className="flex items-start gap-1.5 text-[11px] text-text-300">
                      <ShieldAlert className="w-3.5 h-3.5 text-yellow-400 shrink-0 mt-px" />
                      {t.trustWarning}
                    </p>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setConfirming(null)} className="px-2 py-1 rounded-md text-[11px] border border-bg-300 text-text-300 hover:bg-bg-200">
                        {t.cancel}
                      </button>
                      <button onClick={() => doInstall(p)} disabled={busy === p.name} className="px-2 py-1 rounded-md text-[11px] font-medium bg-accent text-bg-0 hover:opacity-90 disabled:opacity-50">
                        {t.installAnyway}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-[6px] text-[11px] font-medium border transition-colors ${
        active ? "border-accent bg-accent/10 text-text-100" : "border-bg-300 text-text-400 hover:bg-bg-200"
      }`}
    >
      {label}
    </button>
  );
}

function InstalledList({
  installed, enabledIds, updates, onChanged, onError,
}: {
  installed: InstalledPlugin[];
  enabledIds: Set<string>;
  updates: PluginUpdate[];
  onChanged: () => void | Promise<void>;
  /** The panel's error line, at its top. */
  onError: (message: string | null) => void;
}) {
  const tr = useTranslations();
  const t = tr.pluginsPanel;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();
  const updateById = useMemo(() => new Map(updates.map((u) => [u.id, u])), [updates]);

  /** Runs one of a plugin's actions, saying why when it fails instead of dropping it. */
  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    onError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      onError(localizedError(e));
    } finally {
      setBusy(null);
    }
  };
  // Turning a plugin on lets its hooks and servers run: the same trust question as the plugins dialog.
  const toggle = async (p: InstalledPlugin, on: boolean) => {
    if (!on) {
      const ok = await confirm({
        title: tr.pluginsModal.enableConfirmTitle.replace("{name}", p.plugin),
        message: tr.pluginsModal.enableConfirmBody,
        confirmLabel: tr.pluginsModal.enable,
        cancelLabel: tr.pluginsModal.cancel,
      });
      if (!ok) return;
    }
    await run(p.id, () => setEnabled(p.id, !on));
  };

  if (installed.length === 0) return null;

  return (
    <div>
      <h3 className="text-base font-semibold text-text-100 mb-1">{t.installedPlugins}</h3>
      <p className="text-sm text-text-400 mb-3">{t.installedPluginsHint}</p>
      <ul className="space-y-2">
        {installed.map((p) => {
          const on = enabledIds.has(p.id);
          const upd = updateById.get(p.id);
          return (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2.5 rounded-[8px] border border-bg-300 bg-bg-100">
              <button
                onClick={() => void toggle(p, on)}
                disabled={busy === p.id}
                className={`w-9 h-5 shrink-0 rounded-full transition-colors relative ${on ? "bg-accent" : "bg-bg-300"}`}
                aria-label={on ? t.disable : t.enable}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-bg-0 transition-all ${on ? "left-4" : "left-0.5"}`} />
              </button>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-text-100">
                  <Package className="w-3.5 h-3.5 text-text-400 shrink-0" />
                  <span className="truncate">{p.plugin}</span>
                  <span className="text-[10px] text-text-500 font-mono">v{p.version}</span>
                  <span className="text-[10px] text-text-500">· {p.marketplace}</span>
                </span>
              </span>
              {upd && (
                <button
                  onClick={() => void run(p.id, () => updatePlugin(p.id))}
                  disabled={busy === p.id}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border border-accent/50 text-accent hover:bg-accent/10 disabled:opacity-50 shrink-0"
                  data-tooltip={upd.kind === "version" ? t.updateTo.replace("{version}", upd.latest) : undefined}
                >
                  {busy === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUpCircle className="w-3 h-3" />}
                  {upd.kind === "version" ? `v${upd.latest}` : t.update}
                </button>
              )}
              <button
                onClick={() => void run(p.id, () => uninstallPlugin(p.id))}
                disabled={busy === p.id}
                className="p-1 rounded text-text-400 hover:text-red-400 shrink-0 disabled:opacity-50"
                aria-label={t.uninstall}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      {confirmElement}
    </div>
  );
}

export default PluginsPanel;
