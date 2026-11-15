import { type ReactNode } from "react";
import { Download, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PROVIDERS, type ModelInfo, type ProviderId } from "@/lib/models";
import { agentCliOf } from "@/lib/agentCli";
import { isMultiAccountCli, type MultiAccountCli } from "@/lib/cliAccounts";
import { useTranslations } from "@/lib/i18n";
import { useAgentCliPlanUsage, useAgentCliStatus } from "@/lib/useAgentCliStatus";
import { useClaudeCodeStatus, useClaudePlanUsage } from "@/lib/useClaudeCodeStatus";
import { ClaudeCodeAccount, ClaudeCodeConnectors } from "./ClaudeCodeConnect";
import { AgentCliAccount } from "./AgentCliConnect";
import { CliAccountsPanel } from "./CliAccountsPanel";
import { ProviderIcon } from "./ProviderApiKeyModal";
import { ModelSwitchRow } from "./ModelSwitchRow";

// The coding agents (Claude Code and the other CLIs) in Settings › Providers, the way zeron lists
// them: in the list, a switch that connects each one; picked, its version, its accounts (several,
// for the CLIs that keep them) and its models.

/** Which saved-accounts store a provider's CLI uses, when it keeps several. */
function accountsCli(id: ProviderId): MultiAccountCli | null {
  const cli = id === "claude-code" ? "claude-code" : agentCliOf(id);
  return isMultiAccountCli(cli) ? cli : null;
}

/** What the list and the detail need to know about an agent's CLI, from whichever check fits. */
interface AgentState {
  installed: boolean | null;
  version: string | null;
  signedIn: boolean | null;
  onInstall: () => void;
  installing: boolean;
  cancelInstall: () => void;
  /** What went wrong installing it (what the installer said). */
  error: string;
  recheck: () => void;
}

function ClaudeCodeState({ children }: { children: (state: AgentState) => ReactNode }) {
  const { status, phase, waiting, error, check, open, cancelInstall } = useClaudeCodeStatus(undefined, true);
  return children({
    cancelInstall,
    error,
    installed: phase === "checking" || phase === "error" ? null : !!status?.installed,
    version: status?.version ?? null,
    signedIn: status ? !!status.loggedIn : null,
    onInstall: () => void open("install"),
    installing: waiting === "install",
    recheck: () => void check(),
  });
}

function CliState({ id, children }: { id: ProviderId; children: (state: AgentState) => ReactNode }) {
  const { status, waiting, error, check, open, cancelInstall } = useAgentCliStatus(id);
  return children({
    installed: status ? status.installed : null,
    version: status?.version ?? null,
    signedIn: status ? status.loggedIn : null,
    onInstall: () => void open("install"),
    installing: waiting === "install",
    cancelInstall,
    error,
    recheck: () => void check(),
  });
}

function WithState({ id, children }: { id: ProviderId; children: (state: AgentState) => ReactNode }) {
  return id === "claude-code" ? <ClaudeCodeState>{children}</ClaudeCodeState> : <CliState id={id}>{children}</CliState>;
}

function Switch({ on }: { on: boolean }) {
  return (
    <span className={`block w-7 h-4 shrink-0 rounded-full transition-colors relative ${on ? "bg-accent" : "bg-bg-300"}`}>
      <span className={`absolute top-[2px] w-3 h-3 rounded-full bg-bg-0 transition-all ${on ? "left-[14px]" : "left-[2px]"}`} />
    </span>
  );
}

/** An agent in the provider list: picking it shows it; its switch connects it, or a word says
 *  it isn't installed. */
export function AgentListItem({
  id,
  picked,
  on,
  busy,
  onPick,
  onToggle,
  tabbable,
  optionRef,
}: {
  id: ProviderId;
  picked: boolean;
  on: boolean;
  busy: boolean;
  onPick: () => void;
  onToggle: () => void;
  /** The list's single Tab stop (roving tabindex, see ProvidersSection). */
  tabbable: boolean;
  optionRef: (el: HTMLButtonElement | null) => void;
}) {
  const tr = useTranslations();
  const t = tr.settings.agents;
  const name = PROVIDERS[id].name;
  return (
    <WithState id={id}>
      {(state) => {
        const missing = state.installed === false && !on;
        return (
          <div
            className={`flex items-center gap-1 rounded-[6px] pr-1.5 transition-colors ${picked ? "bg-bg-200" : "hover:bg-bg-200"}`}
          >
            <button
              ref={optionRef}
              type="button"
              role="option"
              aria-selected={picked}
              tabIndex={tabbable ? 0 : -1}
              onClick={onPick}
              className={`flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-[13px] text-left ${picked ? "text-text-100" : missing ? "text-text-400" : "text-text-200 hover:text-text-100"}`}
            >
              <span className={missing ? "opacity-60" : undefined}>
                <ProviderIcon id={id} small />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block truncate">{name}</span>
                {state.version && <span className="block truncate text-[11px] leading-4 text-text-500">v{state.version}</span>}
              </span>
            </button>
            {state.installing ? (
              <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-text-400">
                <Loader2 className="w-3 h-3 animate-spin" /> {t.installing}
              </span>
            ) : missing ? (
              <span className="shrink-0 text-[11px] text-text-500">{t.notInstalled}</span>
            ) : busy ? (
              <Loader2 className="w-3.5 h-3.5 mx-1.5 shrink-0 animate-spin text-text-400" />
            ) : (
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={(on ? t.disable : t.enable).replace("{name}", name)}
                disabled={state.installed === null && !on}
                onClick={onToggle}
                // A shortcut for the mouse: a listbox may only hold options, and the agent's page
                // on the right has the same Connect / Disconnect for the keyboard and screen readers.
                tabIndex={-1}
                aria-hidden
                className="shrink-0 rounded-full disabled:opacity-40"
              >
                <Switch on={on} />
              </button>
            )}
          </div>
        );
      }}
    </WithState>
  );
}

/** The saved accounts of a CLI that keeps several, with the limits of the one in use. */
function AccountsFor({ id, cli, ready, onChanged }: { id: ProviderId; cli: MultiAccountCli; ready: boolean; onChanged: () => void }) {
  const claude = useClaudePlanUsage(cli === "claude-code" && ready);
  const other = useAgentCliPlanUsage(id, cli !== "claude-code" && ready);
  const plan = cli === "claude-code" ? claude : other;
  return (
    <CliAccountsPanel
      cli={cli}
      name={PROVIDERS[id].name}
      limits={plan.usage?.limits ?? null}
      refreshing={plan.refreshing}
      onRefreshLimits={() => plan.load(true)}
      onChanged={() => {
        // Another account is in use: its limits aren't the last one's.
        plan.load(true);
        onChanged();
      }}
    />
  );
}

/** A picked agent: its version and the way to connect it, its accounts and its models. */
export function AgentDetail({
  id,
  on,
  busy,
  refreshing,
  firstRead,
  error,
  models,
  enabled,
  onConnect,
  onDisconnect,
  onToggleModel,
  onReloadModels,
}: {
  id: ProviderId;
  on: boolean;
  busy: boolean;
  /** A read the user started (connecting, switching account): the models heading spins. */
  refreshing: boolean;
  /** A quiet read is under way: an empty list says it's loading rather than empty. */
  firstRead: boolean;
  error?: string;
  models: ModelInfo[];
  enabled: Set<string>;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleModel: (modelId: string) => void;
  /** The account in use changed, or the CLI was just signed in: its models are read again. */
  onReloadModels: () => void;
}) {
  const tr = useTranslations();
  const t = tr.settings;
  const name = PROVIDERS[id].name;
  const multi = accountsCli(id);
  return (
    <WithState id={id}>
      {(state) => {
        const missing = state.installed === false;
        return (
          <>
            <div className="flex items-center gap-3 mb-6">
              <ProviderIcon id={id} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="text-[15px] font-medium text-text-100 truncate">{name}</h3>
                  <span className="px-1.5 py-0.5 rounded-[6px] text-[10px] bg-bg-300 text-text-400 shrink-0">
                    {id === "claude-code" ? t.claudeCode.subscription : t.agentCli.account}
                  </span>
                </div>
                {/* The version is in the list; only a missing CLI says what to do here. */}
                {missing && !on && (
                  <p className="mt-0.5 text-[12px] text-text-400 truncate">
                    {state.installing ? t.agents.installingHint.replace("{name}", name) : t.agents.installToEnable.replace("{name}", name)}
                  </p>
                )}
              </div>
              {missing && !on ? (
                state.installing ? (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[13px] text-text-300">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t.agents.installing}
                    </span>
                    <Button variant="ghost" onClick={state.cancelInstall}>
                      {tr.modals.cancel}
                    </Button>
                  </div>
                ) : (
                  <Button variant="primary" onClick={state.onInstall}>
                    <Download className="w-3.5 h-3.5" />
                    {t.agentCli.install}
                  </Button>
                )
              ) : on ? (
                <Button onClick={onDisconnect} className="hover:text-red-400">
                  {t.disconnect}
                </Button>
              ) : (
                <Button variant="primary" onClick={onConnect} disabled={busy || state.installed === null}>
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  {t.connect}
                </Button>
              )}
            </div>

            <div className="space-y-6">
              {!missing &&
                (multi && state.installed ? (
                  <AccountsFor
                    id={id}
                    cli={multi}
                    ready={state.signedIn !== false}
                    onChanged={() => {
                      state.recheck();
                      if (on) onReloadModels();
                    }}
                  />
                ) : (
                  <section>
                    <h4 className="mb-2 text-[12px] text-text-400">{t.account}</h4>
                    {id === "claude-code" ? <ClaudeCodeAccount /> : <AgentCliAccount provider={id} onSignedIn={on ? onReloadModels : undefined} />}
                  </section>
                ))}
              {(error || (missing && state.error)) && (
                <p className="text-[12px] text-red-400 break-words whitespace-pre-line">{error || state.error}</p>
              )}
              {on && (
                <section>
                  <h4 className="mb-1 flex items-center gap-1.5 text-[12px] text-text-400">
                    {t.providerModels}
                    {refreshing && <Loader2 className="w-3 h-3 animate-spin shrink-0" aria-label={tr.models.loading} />}
                  </h4>
                  {models.length === 0 ? (
                    <p className="py-6 text-center text-[12px] text-text-400">{refreshing || firstRead ? tr.models.loading : tr.models.noModelsFound}</p>
                  ) : (
                    <div className="-mx-2">
                      {models.map((m) => (
                        <ModelSwitchRow key={m.id} name={m.name} checked={enabled.has(m.id)} onToggle={() => onToggleModel(m.id)} />
                      ))}
                    </div>
                  )}
                </section>
              )}
              {on && id === "claude-code" && <ClaudeCodeConnectors />}
            </div>
          </>
        );
      }}
    </WithState>
  );
}
