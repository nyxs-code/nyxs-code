import { useEffect, useMemo, useState } from "react";
import { Check, Cookie, Loader2 } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SettingsToggle } from "@/components/settings/settingsControls";
import { invoke } from "@/lib/ipc";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { isFinancialSite } from "@/lib/financialSites";

interface CookieSource {
  id: string;
  browser: "firefox" | "chrome" | "edge" | "brave";
  profile: string;
  supported: boolean;
}

interface CookieSite {
  site: string;
  cookies: number;
}

interface ImportResult {
  sites: number;
  cookies: number;
  failed: number;
}

const BROWSER_NAMES: Record<CookieSource["browser"], string> = { firefox: "Firefox", chrome: "Chrome", edge: "Edge", brave: "Brave" };

/**
 * "Import cookies" of the built-in browser, as Claude Code Desktop has it: pick a browser on this
 * computer and the sites whose cookies come over, so they open signed in. They go into the cookie
 * profile the browser uses now (`profile`); unless the user keeps them, they last until Nyxs quits.
 */
export function CookieImportDialog({
  profile,
  onClose,
  onReload,
}: {
  /** The browser's cookie profile ("private" keeps nothing, so nothing can be imported). */
  profile: string;
  onClose: () => void;
  /** Reloads the page on screen, so it picks the cookies up. */
  onReload?: () => void;
}) {
  const t = useTranslations().cookieImport;
  const tm = useTranslations().modals;
  const [sources, setSources] = useState<CookieSource[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [sites, setSites] = useState<CookieSite[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const isPrivate = profile === "private";

  useEffect(() => {
    let alive = true;
    void invoke<CookieSource[]>("browser_cookie_sources")
      .then((list) => {
        if (!alive) return;
        setSources(list);
        setChosen(list.find((s) => s.supported)?.id ?? null);
      })
      .catch(() => { if (alive) setSources([]); });
    return () => { alive = false; };
  }, []);

  // `sites` is null again whenever a browser is picked (`choose`): the list it shows is read here.
  useEffect(() => {
    if (!chosen) return;
    let alive = true;
    void invoke<CookieSite[]>("browser_cookie_sites", { source: chosen })
      .then((list) => {
        if (!alive) return;
        setSites(list);
        setSelected(new Set(list.filter((s) => !isFinancialSite(s.site)).map((s) => s.site)));
      })
      .catch((e) => {
        if (!alive) return;
        setSites([]);
        setError(String(e));
      });
    return () => { alive = false; };
  }, [chosen]);

  const choose = (id: string) => {
    if (id === chosen) return;
    setSites(null);
    setError("");
    setChosen(id);
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sites ?? []).filter((s) => !q || s.site.includes(q));
  }, [sites, query]);

  const toggle = (site: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });

  const runImport = async () => {
    if (!chosen || selected.size === 0) return;
    setBusy(true);
    setError("");
    try {
      setResult(await invoke<ImportResult>("browser_cookie_import", { source: chosen, sites: [...selected], keep, profile }));
    } catch (e) {
      setError(String(e) === "keychain" ? t.keychainDenied : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasUnreadable = (sources ?? []).some((s) => !s.supported);
  const sourceLabel = (s: CookieSource) => (s.profile ? `${BROWSER_NAMES[s.browser]} · ${t.profile.replace("{name}", s.profile)}` : BROWSER_NAMES[s.browser]);
  const count = selected.size;

  return (
    <Dialog open onClose={() => { if (!busy) onClose(); }} className="max-w-md" dismissible={!busy}>
      <DialogHeader>
        <Cookie className="h-4 w-4 text-accent" />
        <DialogTitle>{t.title}</DialogTitle>
      </DialogHeader>
      {result ? (
        <>
          <div className="px-4 pb-2 text-[13px] text-text-200">
            <p className="flex items-center gap-2">
              <Check className="h-4 w-4 shrink-0 text-success" />
              {(result.sites === 1 ? t.doneOne : t.doneMany).replace("{count}", String(result.sites))}
            </p>
            {result.failed > 0 && <p className="mt-1 text-[12px] text-text-400">{t.someFailed.replace("{count}", String(result.failed))}</p>}
            <p className="mt-1 text-[12px] text-text-400">{keep ? t.keptNote : t.sessionNote}</p>
          </div>
          <DialogFooter>
            {onReload && (
              <Button variant="secondary" onClick={() => { onReload(); onClose(); }}>
                {t.reloadPage}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>{tm.close}</Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <div className="px-4 pb-1 text-[13px] text-text-300">
            <p>{t.intro}</p>

            <p className="mt-3 mb-1.5 text-[12px] font-medium text-text-400">{t.chooseBrowser}</p>
            {sources === null ? (
              <p className="flex items-center gap-2 text-text-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t.looking}</p>
            ) : sources.length === 0 ? (
              <p className="text-text-400">{t.noBrowsers}</p>
            ) : (
              <div role="radiogroup" aria-label={t.chooseBrowser} className="flex flex-col gap-1.5">
                {sources.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={chosen === s.id}
                    disabled={!s.supported || busy}
                    onClick={() => choose(s.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-[6px] border px-2.5 py-1.5 text-left text-[13px] transition-colors",
                      chosen === s.id ? "border-accent bg-accent/10 text-text-100" : "border-bg-300 text-text-200 hover:bg-bg-200",
                      !s.supported && "cursor-default opacity-50 hover:bg-transparent",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{sourceLabel(s)}</span>
                    {!s.supported && <span className="shrink-0 text-[11.5px] text-text-400">{t.unavailable}</span>}
                  </button>
                ))}
              </div>
            )}
            {hasUnreadable && <p className="mt-1.5 text-[12px] text-text-400">{t.onlyFirefox}</p>}

            {chosen && (
              <>
                <div className="mt-3 mb-1.5 flex items-center gap-2">
                  <p className="flex-1 text-[12px] font-medium text-text-400">{t.chooseSites}</p>
                  {sites && sites.length > 0 && (
                    <>
                      <button type="button" onClick={() => setSelected(new Set(shown.map((s) => s.site)))} className="text-[12px] text-text-400 hover:text-text-100">{t.all}</button>
                      <button type="button" onClick={() => setSelected(new Set())} className="text-[12px] text-text-400 hover:text-text-100">{t.none}</button>
                    </>
                  )}
                </div>
                {sites === null ? (
                  <p className="flex items-center gap-2 text-text-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t.reading}</p>
                ) : sites.length === 0 ? (
                  !error && <p className="text-text-400">{t.noSites}</p>
                ) : (
                  <>
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t.search}
                      aria-label={t.search}
                      className="mb-1 w-full rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 py-1 text-[13px] text-text-100 outline-none placeholder:text-text-500 focus:border-text-500"
                    />
                    <ul className="max-h-52 overflow-y-auto custom-scrollbar">
                      {shown.map((s) => (
                        <li key={s.site}>
                          <label className="flex cursor-pointer items-center gap-2.5 rounded-[5px] px-1.5 py-1 hover:bg-bg-200">
                            <input type="checkbox" checked={selected.has(s.site)} onChange={() => toggle(s.site)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
                            <span className="min-w-0 truncate text-text-100">{s.site}</span>
                            {isFinancialSite(s.site) && <span className="shrink-0 rounded-[4px] bg-warning/15 px-1.5 text-[10.5px] text-warning">{t.financial}</span>}
                            <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-text-500">
                              {(s.cookies === 1 ? t.cookiesOne : t.cookiesMany).replace("{count}", String(s.cookies))}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}

            {chosen && !isPrivate && (
              <div className="mt-3 flex items-start gap-3 border-t border-bg-300 pt-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-text-100">{t.keepTitle}</p>
                  <p className="mt-0.5 text-[12px] text-text-400">{t.keepDesc}</p>
                </div>
                <SettingsToggle label={t.keepTitle} checked={keep} onChange={setKeep} />
              </div>
            )}
            {isPrivate && <p className="mt-3 text-[12px] text-warning">{t.privateProfile}</p>}
            {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose} disabled={busy}>{tm.cancel}</Button>
            <Button variant="primary" onClick={() => void runImport()} disabled={busy || isPrivate || !chosen || count === 0}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? t.importing : (count === 1 ? t.importOne : t.importMany).replace("{count}", String(count))}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
