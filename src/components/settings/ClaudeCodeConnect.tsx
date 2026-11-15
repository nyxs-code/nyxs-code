import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, LogIn, RefreshCw } from "lucide-react";
import { localizedError, useTranslations } from "@/lib/i18n";
import { PROVIDERS } from "@/lib/models";
import {
  claudeCodeAccount,
  claudeCodeAccountLabel,
  claudeCodeNeedsUpdate,
  fetchClaudeCodeLatestVersion,
  onClaudeCodeUpdated,
  updateClaudeCode,
  type ClaudeCodeStatus,
} from "@/lib/claudeCode";
import {
  useClaudeCodeStatus,
  useClaudePlanUsage,
  type ClaudeCodePhase as Phase,
  type ClaudeCodeWaiting as Waiting,
} from "@/lib/useClaudeCodeStatus";
import { useSettings } from "@/lib/useSettings";
import { AccountUsageCard } from "./AccountUsageCard";
import { SettingRow, SettingsToggle } from "./settingsControls";
import { WaitingNote } from "./WaitingNote";

/** The newest version on npm, asked once per run of the app. */
let latestVersion: Promise<string> | null = null;
function latestVersionOnce(): Promise<string> {
  latestVersion ??= fetchClaudeCodeLatestVersion().catch((err: unknown) => {
    latestVersion = null;
    throw err;
  });
  return latestVersion;
}

function useClaudeCodeVersion(status: ClaudeCodeStatus | null, onUpdated: () => void) {
  const [latest, setLatest] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState("");

  useEffect(() => {
    if (!status?.installed || latest) return;
    latestVersionOnce().then(setLatest, () => setLatest(null));
  }, [status?.installed, latest]);

  useEffect(() => onClaudeCodeUpdated(onUpdated), [onUpdated]);

  const outdated = claudeCodeNeedsUpdate(status?.version, latest);

  const update = useCallback(async () => {
    setUpdating(true);
    setUpdateError("");
    try {
      await updateClaudeCode();
    } catch (err) {
      setUpdateError(localizedError(err));
    } finally {
      setUpdating(false);
    }
  }, []);

  return { latest, outdated, updating, updateError, update };
}

function UpdateRow({
  current,
  latest,
  updating,
  updateError,
  onUpdate,
}: {
  current: string;
  latest: string;
  updating: boolean;
  updateError: string;
  onUpdate: () => void;
}) {
  const t = useTranslations().settings.claudeCode;
  return (
    <div className="space-y-1.5 border-t border-bg-300 pt-2">
      <p className="text-[12px] text-text-300">
        {t.updateAvailable.replace("{current}", current).replace("{latest}", latest)}
      </p>
      <button
        type="button"
        onClick={onUpdate}
        disabled={updating}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium border border-bg-300 text-text-200 hover:bg-bg-200 disabled:opacity-50"
      >
        {updating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        {updating ? t.updating : t.update}
      </button>
      {updateError && <p className="text-[12px] text-red-400 break-words">{updateError}</p>}
    </div>
  );
}

function StepBody({
  phase,
  status,
  waiting,
  onInstall,
  onLogin,
}: {
  phase: Phase;
  status: ClaudeCodeStatus | null;
  waiting: Waiting;
  onInstall: () => void;
  onLogin: () => void;
}) {
  const t = useTranslations().settings.claudeCode;
  const button =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-sm font-medium bg-accent text-bg-0 hover:opacity-90 disabled:opacity-50";

  if (phase === "checking") {
    return (
      <p className="text-[13px] text-text-300 inline-flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> {t.checking}
      </p>
    );
  }
  if (phase === "missing") {
    return (
      <div className="space-y-2">
        <p className="text-[13px] text-text-200">{t.notInstalled}</p>
        <p className="text-[12px] text-text-400">{t.installHint}</p>
        <button type="button" onClick={onInstall} className={button}>
          <Download className="w-4 h-4" /> {t.install}
        </button>
      </div>
    );
  }
  if (phase === "loggedOut") {
    return (
      <div className="space-y-2">
        <p className="text-[13px] text-text-200">{t.loggedOut.replace("{version}", status?.version ?? "")}</p>
        <p className="text-[12px] text-text-400">{t.loginHint}</p>
        <button type="button" onClick={onLogin} disabled={waiting === "login"} className={button}>
          <LogIn className="w-4 h-4" /> {t.login}
        </button>
      </div>
    );
  }
  if (phase === "ready" && status) {
    const account = claudeCodeAccountLabel(status);
    return <p className="text-[13px] text-text-200">{account ? t.connectedAs.replace("{account}", account) : t.connected}</p>;
  }
  return null;
}

/** Whether the connectors of the user's claude.ai account load into Claude Code sessions. */
export function ClaudeCodeConnectors() {
  const tc = useTranslations().settings.claudeCode;
  const { settings, update } = useSettings();
  const on = (settings as { claudeAiConnectors?: boolean }).claudeAiConnectors ?? false;
  return (
    <section>
      <h4 className="mb-1 text-[12px] text-text-400">{tc.connectorsSection}</h4>
      <SettingRow title={tc.connectorsTitle} desc={tc.connectorsDesc}>
        <SettingsToggle
          checked={on}
          onChange={(v) => update({ claudeAiConnectors: v } as Parameters<typeof update>[0], "user")}
          label={tc.connectorsTitle}
        />
      </SettingRow>
    </section>
  );
}

export function ClaudeCodeAccount() {
  const tc = useTranslations().settings.claudeCode;
  const { status, phase, error, waiting, check, open } = useClaudeCodeStatus(undefined, true);
  const { latest, outdated, updating, updateError, update } = useClaudeCodeVersion(status, check);
  const plan = useClaudePlanUsage(phase === "ready");

  const versionRow = outdated && latest && status?.version && (
    <UpdateRow current={status.version} latest={latest} updating={updating} updateError={updateError} onUpdate={() => void update()} />
  );

  if (phase === "ready" && status) {
    const { who, plan: planName } = claudeCodeAccount(status);
    return (
      <AccountUsageCard
        title={who || tc.connected}
        initialOf={who || PROVIDERS["claude-code"].name}
        subtitle={[planName, status.version && `${PROVIDERS["claude-code"].name} ${status.version}`].filter(Boolean).join(" · ")}
        limits={plan.usage?.limits ?? null}
        loadingLimits={plan.loading}
        refreshing={plan.refreshing}
        refreshLabel={tc.recheck}
        onRefresh={() => {
          void check();
          plan.load(true);
        }}
      >
        {error && <p className="text-[12px] text-red-400 break-words">{error}</p>}
        {versionRow}
      </AccountUsageCard>
    );
  }

  return (
    <div className="mb-3 rounded-[8px] border border-bg-300 bg-bg-200/40 px-3 py-2.5 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <StepBody
            phase={phase}
            status={status}
            waiting={waiting}
            onInstall={() => void open("install")}
            onLogin={() => void open("login")}
          />
        </div>
        <button
          type="button"
          onClick={() => void check()}
          disabled={phase === "checking"}
          className="p-1 rounded text-text-400 hover:text-text-100 shrink-0 disabled:opacity-50"
          aria-label={tc.recheck}
          data-tooltip={tc.recheck}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      {waiting && <WaitingNote waiting={waiting} terminalText={tc.waiting} />}
      {error && <p className="text-[12px] text-red-400 break-words">{error}</p>}
      {versionRow}
    </div>
  );
}
