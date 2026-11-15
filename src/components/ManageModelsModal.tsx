import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Search, Plus, X, Loader2, Server } from "lucide-react";
import { PROVIDERS, PROVIDER_ORDER, getContextWindow, type ProviderId } from "@/lib/models";
import { type Settings } from "@/lib/settings";
import { refreshProviderModels } from "@/lib/refreshModels";
import { localizedError, useTranslations } from "@/lib/i18n";
import { ModelLogo } from "@/components/ui/claude-style-chat-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { ModelSwitchRow } from "@/components/settings/ModelSwitchRow";

const ORDER = PROVIDER_ORDER;

interface ManageModelsModalProps {
  open: boolean;
  settings: Settings;
  onChange: Dispatch<SetStateAction<Settings>>;
  onClose: () => void;
  onConnectProvider?: () => void;
}

/** The models of each connected provider, a tab per provider like the model menu. Opening it
 *  refreshes every provider's list on its own, so there is nothing to reload by hand. */
export function ManageModelsModal(props: ManageModelsModalProps) {
  // Mounted only while open, so every opening starts with a fresh search, errors and refresh.
  return props.open ? <ManageModelsDialog {...props} /> : null;
}

function ManageModelsDialog({ settings, onChange, onClose, onConnectProvider }: ManageModelsModalProps) {
  const tr = useTranslations();
  const t = tr.models;
  const nameOf = (pid: ProviderId) => (pid === "custom" ? tr.settings.customProviderName : PROVIDERS[pid].name);
  const connected = useMemo(() => ORDER.filter((id) => settings[id].apiKey.trim()), [settings]);
  const connectedKey = connected.join(",");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<ProviderId | null>(null);
  const [loading, setLoading] = useState<Partial<Record<ProviderId, boolean>>>(() =>
    Object.fromEntries(connected.map((id) => [id, true])),
  );
  const [errors, setErrors] = useState<Partial<Record<ProviderId, string>>>({});

  const update = (id: ProviderId, patch: Partial<Settings[ProviderId]>) => {
    onChange((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  // Every connected provider's list is fetched again on opening.
  useEffect(() => {
    let alive = true;
    for (const id of connectedKey.split(",").filter(Boolean) as ProviderId[]) {
      refreshProviderModels(id, settings, onChange, () => alive)
        .catch((err) => {
          if (alive) setErrors((e) => ({ ...e, [id]: localizedError(err) }));
        })
        .finally(() => {
          if (alive) setLoading((l) => ({ ...l, [id]: false }));
        });
    }
    return () => { alive = false; };
    // Only a provider connected or disconnected meanwhile fetches again, not every settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedKey, onChange]);

  const id = tab && connected.includes(tab) ? tab : connected[0];

  const toggleModel = (pid: ProviderId, modelId: string) => {
    const set = new Set(settings[pid].enabled ?? []);
    if (set.has(modelId)) set.delete(modelId);
    else set.add(modelId);
    update(pid, { enabled: [...set] });
  };

  // Ollama, LM Studio, a custom endpoint and the other OpenAI-compatible hosts often don't say
  // how much a model takes, and the guess (200k for an unknown one) can be far off: a window set
  // here is what compaction goes by. Empty goes back to the detected one, shown as the hint.
  const windowEditable = !!id && PROVIDERS[id].kind === "openai-compatible";
  const setContextWindow = (pid: ProviderId, modelId: string, raw: string) => {
    const tokens = Number.parseInt(raw, 10);
    onChange((prev) => {
      const windows = { ...(prev[pid].contextWindows ?? {}) };
      if (Number.isFinite(tokens) && tokens > 0) windows[modelId] = tokens;
      else delete windows[modelId];
      return { ...prev, [pid]: { ...prev[pid], contextWindows: windows } };
    });
  };

  const q = query.trim().toLowerCase();
  const all = id ? settings[id].models ?? [] : [];
  // The search stays within the open provider's models, as in the model menu.
  const models = q ? all.filter((m) => `${m.name} ${m.apiModel}`.toLowerCase().includes(q)) : all;
  const enabled = new Set(id ? settings[id].enabled ?? [] : []);
  const busy = id ? loading[id] : false;
  const connect = () => { onClose(); onConnectProvider?.(); };

  return (
    <Dialog open onClose={onClose} stacked className="h-[min(560px,80vh)]">
      {/* A header of its own: the connect button sits beside the close X. */}
      <div className="px-4 pt-3.5 pb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <DialogTitle className="text-[15px] font-semibold">{t.manageModels}</DialogTitle>
          <p className="text-[12px] text-text-400 mt-0.5">{t.manageModelsDesc}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button onClick={connect} className="gap-1 px-2.5 text-[12px] font-normal bg-transparent text-text-200">
            <Plus className="w-3.5 h-3.5" /> {t.connectProvider}
          </Button>
          <Button variant="ghost" icon data-dialog-close onClick={onClose} aria-label={t.close}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {connected.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center pb-6">
          <p className="text-[13px] text-text-300">{t.noProviders}</p>
          <Button onClick={connect} className="mt-3 gap-1 px-2.5 text-[12px] font-normal bg-transparent text-text-200">
            <Plus className="w-3.5 h-3.5" /> {t.connectProvider}
          </Button>
        </div>
      ) : (
        <>
          <div className="mx-4 border-b border-bg-300">
            {/* The bottom padding holds the open tab's underline, on the divider. */}
            <div role="tablist" className="flex items-center gap-0.5 pb-1 overflow-x-auto overflow-y-hidden no-scrollbar">
              {connected.map((pid) => {
                const on = pid === id;
                return (
                  <button
                    key={pid}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    aria-label={nameOf(pid)}
                    onClick={() => { setTab(pid); setQuery(""); }}
                    className={`relative shrink-0 w-7 h-7 flex items-center justify-center rounded-[5px] transition-colors ${on ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100 hover:bg-bg-200"}`}
                  >
                    {pid === "custom" ? (
                      <Server aria-hidden className="w-4 h-4" strokeWidth={1.8} />
                    ) : PROVIDERS[pid].logo ? (
                      <ModelLogo model={PROVIDERS[pid]} className="w-4 h-4" />
                    ) : (
                      <span aria-hidden className="w-4 h-4 inline-flex items-center justify-center rounded-[4px] bg-bg-300 text-[9px] font-semibold text-text-200">
                        {PROVIDERS[pid].name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    {on && <span className="absolute left-1.5 right-1.5 -bottom-1 h-[2px] bg-text-100" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="px-4 pt-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.searchModels}
                className="w-full pl-7 pr-2 py-1 text-[12px] rounded-[5px] bg-bg-200 dark:bg-[#2A2A28] border border-transparent text-text-100 placeholder:text-text-400 outline-none focus:border-accent"
              />
            </div>
            <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[11px] text-text-400">
              <span className="truncate">{id ? nameOf(id) : ""}</span>
              {busy && <Loader2 className="w-3 h-3 animate-spin shrink-0" aria-label={t.loading} />}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-3">
            {id && errors[id] && <p className="px-2 pb-1 text-[11px] text-red-400 break-words">{errors[id]}</p>}
            {models.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-text-400">
                {busy && all.length === 0 ? t.loading : t.noModelsFound}
              </div>
            ) : (
              models.map((m) => (
                <div key={m.id}>
                  <ModelSwitchRow
                    name={m.name}
                    checked={enabled.has(m.id)}
                    onToggle={() => id && toggleModel(id, m.id)}
                    className="rounded-[5px]"
                  />
                  {id && windowEditable && (
                    <label className="flex items-center justify-between gap-3 pl-2 pr-1 pb-1.5 text-[11px] text-text-400">
                      <span className="truncate">{t.contextWindowField}</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        value={settings[id].contextWindows?.[m.id] ?? ""}
                        placeholder={String(getContextWindow(m))}
                        onChange={(e) => setContextWindow(id, m.id, e.target.value)}
                        className="w-28 px-2 py-0.5 text-[12px] tabular-nums rounded-[5px] bg-bg-200 dark:bg-[#2A2A28] border border-transparent text-text-100 placeholder:text-text-400 outline-none focus:border-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                    </label>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

export default ManageModelsModal;
