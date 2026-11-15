import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { localizedError, useTranslations } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import { addCliAccount, activateCliAccount, forgetCliAccount, listCliAccounts, type CliAccount, type MultiAccountCli } from "@/lib/cliAccounts";
import type { PlanLimit } from "@/lib/claudeCode";
import { planLimitLabel } from "@/lib/planLimits";
import { persistedCache } from "@/lib/swrCache";

/** The last list each CLI's accounts had: shown at once, even after a restart, and read again
 *  quietly (zeron's stale-while-revalidate). */
const lastAccounts = persistedCache<CliAccount[]>("nyxs.cliAccounts.v1");

/** A CLI's accounts the way zeron lists them: each saved one with its plan, the one in use with
 *  its limits, a menu to switch to or remove one, and "Add account", which signs in through the
 *  CLI's own login without touching the account in use. */
export function CliAccountsPanel({
  cli,
  name,
  limits,
  refreshing,
  onRefreshLimits,
  onChanged,
}: {
  cli: MultiAccountCli;
  name: string;
  /** The account in use's plan limits, when the CLI reports them. */
  limits: PlanLimit[] | null;
  /** A reading the user asked for is under way (the refresh button spins). */
  refreshing: boolean;
  onRefreshLimits: () => void;
  /** The account in use changed: its models and limits are another account's now. */
  onChanged: () => void;
}) {
  const tr = useTranslations();
  const t = tr.settings.agents;
  const [accounts, setAccountsState] = useState<CliAccount[] | null>(() => lastAccounts.get(cli)?.value ?? null);
  const setAccounts = useCallback(
    (list: CliAccount[]) => {
      lastAccounts.set(cli, list);
      setAccountsState(list);
    },
    [cli],
  );
  const [reloading, setReloading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState<AbortController | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();

  /** Reads the list again; `shown` spins the refresh button (the user asked for it). */
  const reload = useCallback(
    (shown = false) => {
      if (shown) setReloading(true);
      listCliAccounts(cli)
        .then(
          (list) => {
            setAccounts(list);
            setError("");
          },
          (err: unknown) => setError(localizedError(err)),
        )
        .finally(() => setReloading(false));
    },
    [cli, setAccounts],
  );

  useEffect(() => {
    void Promise.resolve().then(() => reload());
  }, [reload]);

  // A sign-in left waiting stops when the panel closes.
  const addingRef = useRef(adding);
  useEffect(() => {
    addingRef.current = adding;
  });
  useEffect(() => () => addingRef.current?.abort(), []);

  const run = async (id: string, action: () => Promise<CliAccount[]>, changesLive: boolean) => {
    setMenuFor(null);
    setBusy(id);
    try {
      setAccounts(await action());
      setError("");
      if (changesLive) onChanged();
    } catch (err) {
      setError(localizedError(err));
    } finally {
      setBusy(null);
    }
  };

  const use = (account: CliAccount) => void run(account.id, () => activateCliAccount(cli, account.id), true);

  const remove = async (account: CliAccount) => {
    setMenuFor(null);
    if (account.active) {
      const ok = await confirm({
        title: t.removeActiveTitle.replace("{email}", account.email),
        message: t.removeActiveBody.replace(/\{name\}/g, name),
        confirmLabel: t.removeAccount,
        cancelLabel: tr.modals.cancel,
        danger: true,
      });
      if (!ok) return;
    }
    void run(account.id, () => forgetCliAccount(cli, account.id), account.active);
  };

  const add = async () => {
    const controller = new AbortController();
    setAdding(controller);
    setError("");
    try {
      const added = await addCliAccount(cli, controller.signal);
      if (added) {
        reload();
        if (added.active) onChanged();
      }
    } catch (err) {
      setError(localizedError(err));
    } finally {
      setAdding(null);
    }
  };

  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-[12px] text-text-400">{t.accounts}</h4>
        <button
          type="button"
          onClick={() => {
            reload(true);
            onRefreshLimits();
          }}
          className="p-1 rounded-[6px] text-text-400 hover:text-text-100"
          aria-label={t.refreshAccounts}
          data-tooltip={t.refreshAccounts}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing || reloading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {accounts === null && !error ? (
        <p className="py-2 text-[12px] text-text-400 inline-flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> {tr.chatInput.usageLoading}
        </p>
      ) : (
        <div className="divide-y divide-bg-300">
          {accounts?.length === 0 && <p className="py-2 text-[12px] text-text-400">{t.noAccounts.replace("{name}", name)}</p>}
          {accounts?.map((account) => (
            <div key={account.id} className="relative flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span
                  aria-hidden
                  className={`w-8 h-8 shrink-0 rounded-full border flex items-center justify-center text-[13px] font-medium ${account.active ? "border-accent text-text-100" : "border-bg-300 text-text-300"}`}
                >
                  {(account.name ?? account.email).trim().charAt(0).toUpperCase() || "?"}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] text-text-100 truncate">{account.email}</p>
                  <p className="text-[12px] text-text-400 truncate">
                    {[account.plan, account.name && account.name !== account.email ? account.name : null].filter(Boolean).join(" · ")}
                    {account.active && (
                      <>
                        {(account.plan || account.name) && " · "}
                        <span className="text-accent">{t.inUse}</span>
                      </>
                    )}
                  </p>
                </div>
              </div>
              {account.active && limits && limits.length > 0 && (
                <div className="w-[17rem] shrink-0 space-y-1.5">
                  {limits.map((limit, i) => (
                    <LimitBar key={`${limit.kind}-${limit.model ?? ""}-${i}`} label={planLimitLabel(limit, tr.chatInput)} used={limit.utilization} />
                  ))}
                </div>
              )}
              <div className="relative shrink-0">
                {busy === account.id ? (
                  <Loader2 className="w-4 h-4 m-1 animate-spin text-text-400" />
                ) : (
                  <button
                    type="button"
                    onClick={() => setMenuFor(menuFor === account.id ? null : account.id)}
                    className="p-1 rounded-[6px] text-text-400 hover:bg-bg-200 hover:text-text-100"
                    aria-label={t.accountMenu}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === account.id}
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                )}
                {menuFor === account.id && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} aria-hidden />
                    <div role="menu" className="absolute right-0 top-full z-20 mt-1 min-w-[11rem] rounded-[8px] border border-bg-300 bg-bg-100 p-1">
                      {!account.active && (
                        <button type="button" role="menuitem" onClick={() => use(account)} className="w-full rounded-[6px] px-2 py-1.5 text-left text-[13px] text-text-200 hover:bg-bg-200">
                          {t.useAccount}
                        </button>
                      )}
                      <button type="button" role="menuitem" onClick={() => void remove(account)} className="w-full rounded-[6px] px-2 py-1.5 text-left text-[13px] text-red-400 hover:bg-bg-200">
                        {t.removeAccount}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="mt-1 flex items-center gap-2 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-text-400 shrink-0" />
          <p className="flex-1 text-[12px] text-text-300">{t.addingAccount.replace("{name}", name)}</p>
          <Button variant="ghost" onClick={() => adding.abort()}>
            {tr.modals.cancel}
          </Button>
        </div>
      ) : (
        <button type="button" onClick={() => void add()} className="mt-1 inline-flex items-center gap-2 rounded-[6px] px-1 py-2 text-[13px] text-text-300 hover:text-text-100">
          <Plus className="w-4 h-4" /> {t.addAccount}
        </button>
      )}
      {error && <p className="text-[12px] text-red-400 break-words">{error}</p>}
      {confirmElement}
    </section>
  );
}

/** A limit as the chat's meter shows it: its whole name and the share used, the bar below. */
function LimitBar({ label, used }: { label: string; used: number }) {
  const color = used >= 100 ? "bg-red-500" : used >= 80 ? "bg-amber-500" : "bg-accent";
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[12px] leading-4 text-text-300 break-words">{label}</span>
        <span className="shrink-0 text-[12px] leading-4 tabular-nums text-text-400">{used}%</span>
      </div>
      <div className="mt-1 h-1 rounded-sm bg-bg-300 overflow-hidden">
        <div className={`h-full rounded-sm ${color}`} style={{ width: `${Math.max(0, Math.min(100, used))}%` }} />
      </div>
    </div>
  );
}
