import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Loader2, Plus, RefreshCw } from "lucide-react";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { localizedError, useTranslations } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import {
  ensureDefaultMarketplaces, listMarketplaces, getCatalog, listInstalled, installPlugin,
  refreshAllMarketplaces, isBuiltinMarketplace, type CatalogPlugin,
} from "@/lib/plugins";
import { cn } from "@/lib/utils";
import { PluginLogo } from "./logos";
import { Dropdown, MenuItem, SearchBox, PillTabs, SquareAction } from "./ui";
import { PLUGINS_CHANGED_EVENT, notifyPluginsChanged } from "./usePluginsData";

type Source = "anthropic" | "partners" | "personal";

type Entry = CatalogPlugin & { marketplace: string; source: Source };

function sourceOf(marketplace: string, author: string | undefined): Source {
  if (!isBuiltinMarketplace(marketplace)) return "personal";
  return /anthropic/i.test(author ?? "") ? "anthropic" : "partners";
}

const pretty = (name: string) => {
  const spaced = name.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** The plugins of every marketplace, to browse and install: Anthropic's, its partners' and
 *  the ones from marketplaces the user added. */
export function PluginDirectory({ onAddMarketplace }: { onAddMarketplace: () => void }) {
  const tr = useTranslations();
  const t = tr.customizePage;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Source>("anthropic");
  const [category, setCategory] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [confirm, confirmElement] = useConfirm();

  const load = useCallback(async () => {
    const errs: string[] = [];
    try {
      await ensureDefaultMarketplaces();
    } catch (e) {
      errs.push(localizedError(e));
    }
    const mps = await listMarketplaces().catch(() => []);
    const all: Entry[] = [];
    await Promise.all(
      mps.map(async (m) => {
        try {
          const cat = await getCatalog(m);
          for (const p of cat.plugins) all.push({ ...p, marketplace: m.name, source: sourceOf(m.name, p.author) });
        } catch (e) {
          errs.push(`${m.name}: ${localizedError(e)}`);
        }
      }),
    );
    all.sort((a, b) => a.name.localeCompare(b.name));
    const inst = await listInstalled().catch(() => []);
    setInstalled(new Set(inst.map((p) => p.id)));
    setEntries(all);
    setErrors(errs);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    const on = () => void load();
    window.addEventListener(PLUGINS_CHANGED_EVENT, on);
    return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, on);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const { failed } = await refreshAllMarketplaces();
      await load();
      if (failed.length) setErrors((e) => [...e, `${t.refreshFailed}: ${failed.map((f) => f.name).join(", ")}`]);
    } catch (e) {
      setErrors([localizedError(e)]);
    } finally {
      setRefreshing(false);
    }
  };

  const install = async (p: Entry) => {
    const ok = await confirm({
      title: t.installPluginTitle.replace("{name}", pretty(p.name)),
      message: tr.pluginsPanel.trustWarning,
      confirmLabel: tr.pluginsPanel.install,
      cancelLabel: tr.pluginsPanel.cancel,
    });
    if (!ok) return;
    setBusy(p.name);
    try {
      await installPlugin(p.marketplace, p.name, { enable: true });
      notifyPluginsChanged();
    } catch (e) {
      setErrors([`${pretty(p.name)}: ${localizedError(e)}`]);
    } finally {
      setBusy(null);
    }
  };

  const inSource = useMemo(() => (entries ?? []).filter((e) => e.source === source), [entries, source]);
  const categories = useMemo(
    () => [...new Set(inSource.map((e) => e.category).filter((c): c is string => !!c))].sort(),
    [inSource],
  );
  const q = query.trim().toLowerCase();
  const visible = inSource.filter(
    (e) =>
      (!category || e.category === category) &&
      (!q || `${e.name} ${e.description} ${e.author ?? ""} ${e.keywords.join(" ")}`.toLowerCase().includes(q)),
  );

  const isInstalled = (p: Entry) => installed.has(`${p.name}@${p.marketplace}`);

  const action = (p: Entry) =>
    busy === p.name ? (
      <SquareAction label={t.installing} disabled>
        <Loader2 className="w-4 h-4 animate-spin" />
      </SquareAction>
    ) : isInstalled(p) ? (
      <SquareAction label={t.installed} tone="success" disabled>
        <Check className="w-4 h-4" />
      </SquareAction>
    ) : (
      <SquareAction label={t.install} onClick={() => void install(p)}>
        <Plus className="w-4 h-4" />
      </SquareAction>
    );

  if (selected) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="inline-flex items-center gap-1.5 text-[14px] text-text-200 hover:text-text-100 mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          {t.plugins}
        </button>
        <div className="flex items-start gap-4 pb-6 border-b border-bg-300">
          <PluginLogo name={selected.name} hints={`${selected.category ?? ""} ${selected.keywords.join(" ")} ${selected.description}`} size={48} />
          <div className="flex-1 min-w-0">
            <h2 className="text-[22px] text-text-100">{pretty(selected.name)}</h2>
            <p className="text-[13px] text-text-400 mt-0.5">
              {selected.author ? t.byDeveloper.replace("{name}", selected.author) : selected.marketplace}
              {" · "}v{selected.version}
            </p>
          </div>
          <button
            type="button"
            disabled={isInstalled(selected) || busy === selected.name}
            onClick={() => void install(selected)}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-[8px] bg-text-100 text-bg-0 text-[14px] font-medium hover:opacity-90 disabled:opacity-60"
          >
            {busy === selected.name && <Loader2 className="w-4 h-4 animate-spin" />}
            {isInstalled(selected) ? t.installed : t.install}
          </button>
        </div>
        <p className="text-[14px] text-text-200 leading-relaxed mt-6">{selected.description || tr.pluginsPanel.noDescription}</p>
        {(selected.category || selected.keywords.length > 0) && (
          <div className="flex flex-wrap gap-2 mt-6">
            {selected.category && (
              <span className="h-7 px-2.5 inline-flex items-center rounded-[6px] bg-bg-200 text-[13px] text-text-200">{selected.category}</span>
            )}
            {selected.keywords.map((k) => (
              <span key={k} className="h-7 px-2.5 inline-flex items-center rounded-[6px] border border-bg-300 text-[13px] text-text-300">{k}</span>
            ))}
          </div>
        )}
        {selected.homepage && (
          <a
            href={selected.homepage}
            onClick={handleExternalLinkClick}
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 mt-6 text-[14px] text-text-100 underline underline-offset-2"
          >
            {t.website} <ArrowUpRight className="w-3.5 h-3.5" />
          </a>
        )}
        {confirmElement}
      </div>
    );
  }

  return (
    <div>
      <SearchBox value={query} onChange={setQuery} placeholder={t.searchPlugins} size="lg" autoFocus />
      <div className="flex items-center gap-2 mt-3 mb-4">
        <PillTabs
          value={source}
          onChange={(s) => { setSource(s); setCategory(null); }}
          items={[
            { id: "anthropic", label: t.sourceAnthropic },
            { id: "partners", label: t.sourcePartners },
            { id: "personal", label: t.sourcePersonal },
          ]}
        />
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label={t.refresh}
          className="ml-auto w-8 h-8 rounded-[6px] flex items-center justify-center text-text-300 hover:bg-bg-200 hover:text-text-100"
        >
          <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
        </button>
        <Dropdown
          trigger={(open, toggle) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-200 hover:text-text-100"
            >
              {category ?? t.filter}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem label={t.allCategories} checked={!category} onClick={() => { setCategory(null); close(); }} />
              {categories.map((c) => (
                <MenuItem
                  key={c}
                  label={c}
                  checked={category === c}
                  count={inSource.filter((e) => e.category === c).length}
                  onClick={() => { setCategory(c); close(); }}
                />
              ))}
            </>
          )}
        </Dropdown>
        <button
          type="button"
          onClick={onAddMarketplace}
          aria-label={t.addMarketplace}
          className="w-8 h-8 rounded-[6px] flex items-center justify-center text-text-300 hover:bg-bg-200 hover:text-text-100"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {errors.map((e) => (
        <p key={e} className="text-[12px] text-red-400 mb-2 break-words">{e}</p>
      ))}

      {entries === null ? (
        <div className="flex items-center gap-2 py-16 justify-center text-[13px] text-text-400">
          <Loader2 className="w-4 h-4 animate-spin" /> {t.loadingCatalog}
        </div>
      ) : visible.length === 0 ? (
        <div className="py-14 text-center">
          <p className="text-[14px] text-text-300">{source === "personal" && !q ? t.noPersonalMarketplaces : t.noResults}</p>
          {source === "personal" && !q && (
            <button
              type="button"
              onClick={onAddMarketplace}
              className="mt-4 h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-100 hover:bg-bg-300"
            >
              {t.addMarketplace}
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {visible.map((p) => (
            <div
              key={`${p.marketplace}/${p.name}`}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(p)}
              onKeyDown={(e) => { if (e.key === "Enter") setSelected(p); }}
              className="flex flex-col gap-3 p-4 rounded-[8px] border border-bg-300 bg-bg-100 shadow-sm hover:bg-bg-200/40 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <div className="flex items-start gap-3">
                <PluginLogo name={p.name} hints={`${p.category ?? ""} ${p.keywords.join(" ")} ${p.description.slice(0, 120)}`} size={40} />
                <div className="flex-1 min-w-0">
                  <p className="text-[14px] font-medium text-text-100 truncate">{pretty(p.name)}</p>
                  {p.author && <p className="text-[12.5px] text-text-400 truncate">{p.author}</p>}
                </div>
                {action(p)}
              </div>
              <p className="text-[13px] text-text-400 leading-snug line-clamp-2">{p.description || tr.pluginsPanel.noDescription}</p>
            </div>
          ))}
        </div>
      )}
      {confirmElement}
    </div>
  );
}
