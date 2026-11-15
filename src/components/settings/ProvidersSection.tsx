import { useCallback, useEffect, useId, useRef, useState, type Dispatch, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { PROVIDERS, PROVIDER_ORDER, type ProviderId } from "@/lib/models";
import { Button } from "@/components/ui/button";
import { type Settings } from "@/lib/settings";
import { fetchProviderModels } from "@/lib/providerModels";
import { refreshProviderModels } from "@/lib/refreshModels";
import { listboxMove } from "@/lib/listboxKeys";
import { agentCliDefaultEnabled, agentCliOf, fetchAgentCliModels, AGENT_CLI_CONNECTED } from "@/lib/agentCli";
import { syncAntigravityMcp } from "@/lib/mcpBridge";
import { CLAUDE_CODE_CONNECTED, CLAUDE_CODE_DEFAULT_ENABLED, CLAUDE_CODE_MODELS, fetchClaudeCodeModels } from "@/lib/claudeCode";
import { localizedError, useTranslations } from "@/lib/i18n";
import { forgetModelsRead, markModelsRead, modelsAreFresh } from "@/lib/modelsFreshness";
import { ProviderApiKeyModal, ProviderIcon } from "./ProviderApiKeyModal";
import { AgentDetail, AgentListItem } from "./AgentProviders";
import { AgentCliConnectModal } from "./AgentCliConnect";
import { SectionTitle } from "./settingsControls";
import { ModelSwitchRow } from "./ModelSwitchRow";
import { fold } from "./settingsNav";
import { useSavedField } from "./useSaveOnLeave";

const isAgent = (id: ProviderId) => id === "claude-code" || !!agentCliOf(id);
/** The coding agents, run on the user's own sign-in: Claude Code and the other CLIs. */
const AGENTS: ProviderId[] = PROVIDER_ORDER.filter(isAgent);
/** The providers reached with an API key (or a local server). */
const ORDER: ProviderId[] = PROVIDER_ORDER.filter((id) => !isAgent(id));

const caption = "px-2 mb-1 text-[12px] text-text-400";

/** Settings › Providers: the coding agents (each with a switch that connects it) and every API
 *  provider in a list on the left, and the one picked on the right with its account(s), its
 *  models and the way to connect or disconnect.
 *  Showing a connected provider refreshes its models, so there is nothing to reload by hand. */
export function ProvidersSection({ settings, onChange }: { settings: Settings; onChange: Dispatch<SetStateAction<Settings>> }) {
  const tr = useTranslations();
  const t = tr.settings;
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<ProviderId, string>>>({});
  const [connecting, setConnecting] = useState<ProviderId | null>(null);
  const [connectKey, setConnectKey] = useState("");
  const [connectBaseUrl, setConnectBaseUrl] = useState("");
  const [connectWorkspace, setConnectWorkspace] = useState("");
  const [selected, setSelected] = useState<ProviderId | null>(null);
  const [keyFor, setKeyFor] = useState<ProviderId | null>(null);
  const [query, setQuery] = useState("");

  const isConnected = (id: ProviderId) => !!settings[id].apiKey.trim();
  const connected = ORDER.filter(isConnected);
  const available = ORDER.filter((id) => !isConnected(id));
  const current = selected ?? AGENTS.find(isConnected) ?? connected[0] ?? AGENTS[0];

  const nameOf = (id: ProviderId) => (id === "custom" ? t.customProviderName : PROVIDERS[id].name);
  const descOf = (id: ProviderId) => t.providerDesc[id] ?? PROVIDERS[id].description;
  const kindOf = (id: ProviderId) => (PROVIDERS[id].local ? t.localProvider : t.apiKey);

  const q = fold(query.trim());
  const matches = (id: ProviderId) => !q || fold(nameOf(id)).includes(q) || fold(descOf(id) ?? "").includes(q);
  const shownAgents = AGENTS.filter(matches);
  const shownConnected = connected.filter(matches);
  const shownAvailable = available.filter(matches);

  const update = (id: ProviderId, patch: Partial<Settings[ProviderId]>) => {
    onChange((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  // The shown provider's list is read again quietly when it's old (see modelsFreshness).
  const shown = current && isConnected(current) ? current : null;
  const [reading, setReading] = useState<Partial<Record<ProviderId, boolean>>>({});
  useEffect(() => {
    if (!shown || modelsAreFresh(shown)) return;
    let alive = true;
    // A failed read over a list there is keeps the list, quietly.
    const hadModels = (settings[shown].models?.length ?? 0) > 0;
    setReading((r) => ({ ...r, [shown]: true }));
    refreshProviderModels(shown, settings, onChange, () => alive)
      .then(() => {
        if (!alive) return;
        // Only a read that finished is fresh; a failed one is tried again next time it's shown.
        markModelsRead(shown);
        setErrors((e) => ({ ...e, [shown]: undefined }));
      })
      .catch((err) => {
        if (alive && !hadModels) setErrors((e) => ({ ...e, [shown]: localizedError(err) }));
      })
      .finally(() => {
        // Cleared even when the effect was cancelled: otherwise coming back to it would say
        // "Loading…" forever.
        setReading((r) => ({ ...r, [shown]: false }));
      });
    return () => {
      alive = false;
    };
    // Only picking a provider whose list is old (or connecting one) reads it, not every settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const openConnect = (id: ProviderId) => {
    setConnecting(id);
    setConnectKey("");
    setConnectWorkspace(settings[id].workspaceId ?? "");
    setConnectBaseUrl(settings[id].baseUrl ?? PROVIDERS[id].defaultBaseUrl ?? "");
    setErrors((e) => ({ ...e, [id]: undefined }));
  };

  const saveConnect = (id: ProviderId) => {
    const key = connectKey.trim() || (PROVIDERS[id].local ? "local" : "");
    if (!key) return;
    const patch: Partial<Settings[ProviderId]> = { apiKey: key };
    if (PROVIDERS[id].kind === "openai-compatible") patch.baseUrl = connectBaseUrl.trim() || PROVIDERS[id].defaultBaseUrl;
    if (id === "anthropic") patch.workspaceId = connectWorkspace.trim() || undefined;
    update(id, patch);
    setConnecting(null);
    setConnectKey("");
    setConnectWorkspace("");
    setSelected(id);
  };

  // The provider stays picked: its page turns into the one to connect it again.
  const disconnect = (id: ProviderId) => {
    update(id, { apiKey: "", models: [], enabled: [] });
    setSelected(id);
    // Connected again, its list is read again.
    forgetModelsRead(id);
    if (agentCliOf(id) === "antigravity") void syncAntigravityMcp({ browser: false, chatTools: false, video: false }).catch(() => undefined);
  };

  /** An agent's own sign-in is what connects it (DeepSeek Harness's API key, for that one). */
  const connectAgent = async (id: ProviderId, apiKey?: string) => {
    if (id === "deepseek-cli" && !apiKey) {
      setKeyFor(id);
      return;
    }
    setKeyFor(null);
    setLoading((l) => ({ ...l, [id]: true }));
    setErrors((e) => ({ ...e, [id]: undefined }));
    try {
      if (id === "claude-code") {
        const models = await fetchClaudeCodeModels().catch(() => CLAUDE_CODE_MODELS);
        const available = new Set(models.map((m) => m.id));
        onChange((prev) => ({
          ...prev,
          "claude-code": { ...prev["claude-code"], apiKey: CLAUDE_CODE_CONNECTED, models, enabled: CLAUDE_CODE_DEFAULT_ENABLED.filter((m) => available.has(m)) },
        }));
      } else {
        const cli = agentCliOf(id);
        if (!cli) return;
        const models = await fetchAgentCliModels(cli, apiKey);
        onChange((prev) => ({ ...prev, [id]: { ...prev[id], apiKey: apiKey ?? AGENT_CLI_CONNECTED, models, enabled: agentCliDefaultEnabled(models) } }));
        // Antigravity gets Nyxs' built-in browser and chat tools in its own MCP config (Grok gets
        // them per session); each turn checks them again with the browser setting.
        if (cli === "antigravity") void syncAntigravityMcp({ browser: true, chatTools: true, video: true }).catch(() => undefined);
      }
      markModelsRead(id);
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: localizedError(err) }));
    } finally {
      setLoading((l) => ({ ...l, [id]: false }));
    }
  };

  /** An agent's models read again: its account changed, or it was just signed in. */
  const reloadModels = useCallback(
    async (id: ProviderId, patch?: Partial<Settings[ProviderId]>) => {
      const cfg = { ...settings[id], ...patch };
      setLoading((l) => ({ ...l, [id]: true }));
      setErrors((e) => ({ ...e, [id]: undefined }));
      try {
        const models = await fetchProviderModels(PROVIDERS[id], cfg);
        const valid = new Set(models.map((m) => m.id));
        onChange((prev) => {
          const kept = (prev[id].enabled ?? []).filter((mid) => valid.has(mid));
          // A CLI connected before signing in had only its default: its first real model comes on too.
          const enabled = agentCliOf(id) ? [...new Set([...kept, ...agentCliDefaultEnabled(models)])] : kept;
          return { ...prev, [id]: { ...prev[id], models, enabled } };
        });
      } catch (err) {
        setErrors((e) => ({ ...e, [id]: localizedError(err) }));
      } finally {
        setLoading((l) => ({ ...l, [id]: false }));
      }
    },
    [settings, onChange],
  );

  const connectLocal = async (id: ProviderId) => {
    const baseUrl = settings[id].baseUrl || PROVIDERS[id].defaultBaseUrl;
    setLoading((l) => ({ ...l, [id]: true }));
    setErrors((e) => ({ ...e, [id]: undefined }));
    try {
      const models = await fetchProviderModels(PROVIDERS[id], { ...settings[id], apiKey: "local", baseUrl });
      onChange((prev) => ({ ...prev, [id]: { ...prev[id], apiKey: "local", baseUrl, models, enabled: [] } }));
      setSelected(id);
    } catch {
      setErrors((e) => ({ ...e, [id]: t.localServerOffline.replace("{name}", PROVIDERS[id].name) }));
    } finally {
      setLoading((l) => ({ ...l, [id]: false }));
    }
  };

  const connect = (id: ProviderId) => {
    if (PROVIDERS[id].local) void connectLocal(id);
    else openConnect(id);
  };

  const toggleModel = (id: ProviderId, modelId: string) => {
    onChange((prev) => {
      const set = new Set(prev[id].enabled ?? []);
      if (set.has(modelId)) set.delete(modelId);
      else set.add(modelId);
      return { ...prev, [id]: { ...prev[id], enabled: [...set] } };
    });
  };

  // The list is a listbox: one Tab stop (the provider shown, else the first one listed), the
  // arrows, Home/End and typing a letter move the selection, and the selection is what's shown.
  const shownIds = [...shownAgents, ...shownConnected, ...shownAvailable];
  const tabStop = shownIds.includes(current) ? current : shownIds[0];
  const options = useRef(new Map<ProviderId, HTMLButtonElement>());
  const optionRef = (id: ProviderId) => (el: HTMLButtonElement | null) => {
    if (el) options.current.set(id, el);
    else options.current.delete(id);
  };
  const pick = (id: ProviderId) => {
    setSelected(id);
    options.current.get(id)?.focus();
  };
  const onListKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = listboxMove(shownIds, shownIds.includes(current) ? current : null, e.key, nameOf);
    if (!next) return;
    e.preventDefault();
    pick(next);
  };
  const listboxId = useId();

  const listItem = (id: ProviderId) => {
    const on = isConnected(id);
    const picked = current === id;
    return (
      <button
        key={id}
        ref={optionRef(id)}
        type="button"
        role="option"
        aria-selected={picked}
        tabIndex={tabStop === id ? 0 : -1}
        onClick={() => setSelected(id)}
        className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-[13px] text-left transition-colors ${picked ? "bg-bg-200 text-text-100" : on ? "text-text-200 hover:bg-bg-200 hover:text-text-100" : "text-text-300 hover:bg-bg-200 hover:text-text-100"}`}
      >
        <ProviderIcon id={id} small />
        <span className="flex-1 min-w-0 truncate">{nameOf(id)}</span>
        {on && <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" role="img" aria-label={t.providerConnected} />}
      </button>
    );
  };

  const agentItem = (id: ProviderId) => (
    <AgentListItem
      key={id}
      id={id}
      picked={current === id}
      on={isConnected(id)}
      busy={!!loading[id]}
      onPick={() => setSelected(id)}
      tabbable={tabStop === id}
      optionRef={optionRef(id)}
      onToggle={() => {
        setSelected(id);
        if (isConnected(id)) disconnect(id);
        else void connectAgent(id);
      }}
    />
  );

  const agentDetail = (id: ProviderId) => (
    <AgentDetail
      key={id}
      id={id}
      on={isConnected(id)}
      busy={!!loading[id]}
      refreshing={!!loading[id]}
      firstRead={!!reading[id]}
      error={errors[id]}
      models={settings[id].models ?? []}
      enabled={new Set(settings[id].enabled ?? [])}
      onConnect={() => void connectAgent(id)}
      onDisconnect={() => disconnect(id)}
      onToggleModel={(modelId) => toggleModel(id, modelId)}
      onReloadModels={() => void reloadModels(id)}
    />
  );

  /** A titled section of the listbox. */
  const group = (key: string, title: string, items: ReactNode[]) =>
    items.length > 0 && (
      <div role="group" aria-labelledby={key}>
        <p id={key} className={caption}>{title}</p>
        <div className="space-y-0.5">{items}</div>
      </div>
    );

  const detail = (id: ProviderId) => {
    if (isAgent(id)) return agentDetail(id);
    const cfg = settings[id];
    const busy = loading[id];
    const on = isConnected(id);
    const models = cfg.models ?? [];
    const enabled = new Set(cfg.enabled ?? []);
    // A spinner only for a read the user started; an empty list says it's loading meanwhile.
    const refreshing = busy;
    const count = t.capabilitiesPage.modelsEnabledCount.replace("{enabled}", String(enabled.size)).replace("{total}", String(models.length));

    const header = (
      <div className="flex items-start gap-3 mb-6">
        <ProviderIcon id={id} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-[15px] font-medium text-text-100 truncate">{nameOf(id)}</h3>
            <span className="px-1.5 py-0.5 rounded-[6px] text-[10px] bg-bg-300 text-text-400 shrink-0">{kindOf(id)}</span>
          </div>
          {on ? (
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-text-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              {models.length ? `${t.providerConnected} · ${count}` : t.providerConnected}
            </p>
          ) : (
            <p className="mt-0.5 text-[12px] text-text-400">{descOf(id)}</p>
          )}
        </div>
        {on ? (
          <Button onClick={() => disconnect(id)} className="hover:text-red-400">
            {t.disconnect}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => connect(id)} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {t.connect}
          </Button>
        )}
      </div>
    );

    if (!on) {
      return (
        <>
          {header}
          {errors[id] && <p className="text-[12px] text-red-400 break-words">{errors[id]}</p>}
        </>
      );
    }

    return (
      <>
        {header}
        {/* An organization-scoped key isn't bound to a workspace, so it names one here. */}
        {id === "anthropic" && (
          <WorkspaceIdField
            value={cfg.workspaceId ?? ""}
            label={t.workspaceId}
            placeholder={t.workspaceIdPlaceholder}
            hint={t.workspaceIdHint}
            onSave={(workspaceId) => {
              update(id, { workspaceId: workspaceId || undefined });
              void reloadModels(id, { workspaceId });
            }}
          />
        )}
        <section>
          <h4 className="mb-1 flex items-center gap-1.5 text-[12px] text-text-400">
            {t.providerModels}
            {refreshing && <Loader2 className="w-3 h-3 animate-spin shrink-0" aria-label={tr.models.loading} />}
          </h4>
          {errors[id] && <p className="mb-2 text-[12px] text-red-400 break-words">{errors[id]}</p>}
          {models.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-text-400">{refreshing || reading[id] ? tr.models.loading : tr.models.noModelsFound}</p>
          ) : (
            // The same switch rows as Manage models: the name alone.
            <div className="-mx-2">
              {models.map((m) => (
                <ModelSwitchRow key={m.id} name={m.name} checked={enabled.has(m.id)} onToggle={() => toggleModel(id, m.id)} />
              ))}
            </div>
          )}
        </section>
      </>
    );
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col px-8 pt-7 pb-6">
      <SectionTitle>{t.providers}</SectionTitle>

      <div className="flex flex-1 min-h-0 rounded-[8px] border border-bg-300">
        <div className="w-72 shrink-0 flex flex-col border-r border-bg-300">
          <div className="p-2.5 pb-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-400 pointer-events-none" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" || !tabStop) return;
                  e.preventDefault();
                  pick(tabStop);
                }}
                aria-controls={listboxId}
                placeholder={t.searchSettings}
                aria-label={t.searchSettings}
                spellCheck={false}
                className="w-full h-8 pl-8 pr-2.5 rounded-[6px] border border-bg-300 bg-bg-100 text-[13px] text-text-100 placeholder:text-text-500 outline-none focus:border-accent transition-colors"
              />
            </div>
          </div>
          <div
            id={listboxId}
            // With nothing matching the search it only holds the "no results" line.
            role={shownIds.length ? "listbox" : undefined}
            aria-label={shownIds.length ? t.providers : undefined}
            onKeyDown={onListKeyDown}
            className="flex-1 overflow-y-auto custom-scrollbar px-2.5 py-2 space-y-4"
          >
            {group(`${listboxId}-agents`, t.agentsNav, shownAgents.map(agentItem))}
            {group(`${listboxId}-connected`, t.connectedProviders, shownConnected.map(listItem))}
            {group(`${listboxId}-available`, t.popularProviders, shownAvailable.map(listItem))}
            {!shownAgents.length && !shownConnected.length && !shownAvailable.length && <p className="px-2 text-[12px] text-text-400">{t.noResults}</p>}
          </div>
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto custom-scrollbar px-6 py-5">{current && detail(current)}</div>
      </div>

      {connecting && (
        <ProviderApiKeyModal
          providerId={connecting}
          apiKey={connectKey}
          baseUrl={connectBaseUrl}
          reveal={!!reveal[connecting]}
          customProviderLabel={t.customProviderName}
          onApiKeyChange={setConnectKey}
          onBaseUrlChange={setConnectBaseUrl}
          onWorkspaceIdChange={setConnectWorkspace}
          workspaceId={connectWorkspace}
          onRevealToggle={() => setReveal((r) => ({ ...r, [connecting]: !r[connecting] }))}
          onSave={() => saveConnect(connecting)}
          onClose={() => {
            setConnecting(null);
            setConnectKey("");
            setConnectWorkspace("");
          }}
        />
      )}
      {keyFor && (
        <AgentCliConnectModal
          provider={keyFor}
          defaultKey={settings.deepseek?.apiKey ?? ""}
          onConnect={(apiKey) => void connectAgent(keyFor, apiKey)}
          onClose={() => setKeyFor(null)}
        />
      )}
    </div>
  );
}

/** The workspace an organization-scoped Anthropic key acts in. It saves (and re-reads the
 *  models) when it changes, not on every keystroke. */
function WorkspaceIdField({
  value,
  label,
  placeholder,
  hint,
  onSave,
}: {
  value: string;
  label: string;
  placeholder: string;
  hint: string;
  onSave: (value: string) => void;
}) {
  // Saved on blur, Enter or when Settings closes, only if it changed.
  const field = useSavedField(value, onSave);
  return (
    <section className="mb-5">
      <label htmlFor="provider-workspace-id-field" className="mb-1.5 block text-[12px] text-text-400">
        {label}
      </label>
      <input
        id="provider-workspace-id-field"
        type="text"
        {...field}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder={placeholder}
        spellCheck={false}
        className="w-full h-8 px-2.5 rounded-[6px] border border-bg-300 bg-bg-100 text-[13px] text-text-100 placeholder:text-text-500 outline-none focus:border-accent transition-colors font-mono"
      />
      <p className="mt-1.5 text-[11px] text-text-400">{hint}</p>
    </section>
  );
}
