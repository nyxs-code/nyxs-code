import { useEffect, useState } from "react";
import { X, Check, AlertTriangle, Minus, Activity, RefreshCw, Download, Loader2 } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { getMergedSettings } from "@/lib/settingsRuntime";
import { getDiagnosticsRuntime } from "@/lib/diagnostics";
import { loadMergedMcpServers, mcpServerTarget } from "@/lib/mcp";
import { hasKey, type Settings } from "@/lib/settings";
import { PROVIDERS, type ProviderId } from "@/lib/models";
import { detectContainer, type ContainerInfo } from "@/lib/containerInfo";
import { localizedError, useTranslations } from "@/lib/i18n";
import { invoke } from "@/lib/ipc";
import { saveLogsZip } from "@/lib/logs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";

type Status = "ok" | "warn" | "info";

interface Check {
  label: string;
  value: string;
  status: Status;
  details?: string[];
}

interface Section {
  title: string;
  checks: Check[];
}

const STATUS_ICON: Record<Status, typeof Check> = {
  ok: Check,
  warn: AlertTriangle,
  info: Minus,
};
const STATUS_COLOR: Record<Status, string> = {
  ok: "text-green-400",
  warn: "text-amber-400",
  info: "text-text-500",
};

export function DoctorModal({
  open,
  onClose,
  settings,
  workspace,
  permissionMode,
  selectedModel,
}: {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  workspace: string | null;
  permissionMode: string;
  selectedModel: string;
}) {
  const t = useTranslations().doctor;
  const [sections, setSections] = useState<Section[] | null>(null);
  const [loading, setLoading] = useState(false);

  const collect = async (): Promise<Section[]> => {
    let version = "?";
    try {
      version = await getVersion();
    } catch {
      /* not in Tauri */
    }

    const providerIds = Object.keys(PROVIDERS) as ProviderId[];
    const withKey = providerIds.filter((id) => hasKey(settings, id));
    const modelProvider = (selectedModel.split(":")[0] as ProviderId) || undefined;
    const modelHasKey = modelProvider ? hasKey(settings, modelProvider) : false;

    let mcpServers: { name: string; enabled: boolean; url: string }[] = [];
    try {
      mcpServers = loadMergedMcpServers().map((s) => ({ name: s.name, enabled: s.enabled, url: mcpServerTarget(s) }));
    } catch {
      /* none configured */
    }
    const mcpEnabled = mcpServers.filter((s) => s.enabled && s.url.trim());

    let allow = 0;
    let deny = 0;
    let ask = 0;
    try {
      const merged = await getMergedSettings();
      allow = merged.permissions?.allow?.length ?? 0;
      deny = merged.permissions?.deny?.length ?? 0;
      ask = merged.permissions?.ask?.length ?? 0;
    } catch {
      /* defaults */
    }
    const diag = await getDiagnosticsRuntime();
    let diagEnabled = true;
    try {
      const merged = await getMergedSettings();
      const d = merged.diagnostics as { enabled?: boolean } | undefined;
      diagEnabled = d?.enabled !== false;
    } catch {
      /* default on */
    }

    let container: ContainerInfo = { inContainer: false, runtime: null, markers: [] };
    try {
      container = await detectContainer();
    } catch {
      /* not in Tauri / probe failed → treat as host */
    }

    return [
      {
        title: t.secAppTitle,
        checks: [{ label: t.versionLabel, value: `v${version}`, status: "info" }],
      },
      {
        title: t.workspaceTitle,
        checks: [
          workspace
            ? { label: t.pathLabel, value: workspace, status: "ok" }
            : { label: t.pathLabel, value: t.noFolder, status: "warn" },
        ],
      },
      {
        title: t.modelTitle,
        checks: [
          {
            label: t.currentModel,
            value: selectedModel || "—",
            status: modelHasKey ? "ok" : "warn",
            details: modelHasKey ? undefined : [t.noKeyForModel],
          },
          {
            label: t.providersWithKey,
            value: withKey.length
              ? t.countOfTotal.replace("{count}", String(withKey.length)).replace("{total}", String(providerIds.length))
              : t.none,
            status: withKey.length ? "ok" : "warn",
            details: withKey.map((id) => PROVIDERS[id].name),
          },
        ],
      },
      {
        title: t.mcpTitle,
        checks: [
          {
            label: t.configured,
            value: mcpServers.length
              ? t.mcpEnabledCount
                  .replace("{enabled}", String(mcpEnabled.length))
                  .replace("{total}", String(mcpServers.length))
              : t.none,
            status: mcpServers.length ? "ok" : "info",
            details: mcpServers.map((s) => `${s.enabled ? "●" : "○"} ${s.name}`),
          },
        ],
      },
      {
        title: t.permsTitle,
        checks: [
          { label: t.currentMode, value: permissionMode, status: "info" },
          {
            label: t.rulesLabel,
            value: t.rulesValue
              .replace("{allow}", String(allow))
              .replace("{deny}", String(deny))
              .replace("{ask}", String(ask)),
            status: "info",
          },
        ],
      },
      {
        title: t.diagTitle,
        checks: [
          {
            label: t.statusLabel,
            value: diagEnabled ? t.enabled : t.disabled,
            status: diagEnabled ? "ok" : "info",
            details: diagEnabled
              ? [
                  t.autoFix.replace(
                    "{value}",
                    diag.autoFix ? t.autoFixYes.replace("{max}", String(diag.maxAttempts)) : t.autoFixNo,
                  ),
                  t.visibleInUi.replace("{value}", diag.showInUi ? t.yes : t.no),
                ]
              : undefined,
          },
        ],
      },
      {
        title: t.envTitle,
        checks: [
          {
            label: t.container,
            value: container.inContainer
              ? container.runtime
                ? t.inContainerRuntime.replace("{runtime}", container.runtime)
                : t.inContainer
              : t.onHost,
            status: "info",
            details: container.markers.length ? container.markers : undefined,
          },
        ],
      },
    ];
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setSections(null);
      try {
        const s = await collect();
        if (!cancelled) setSections(s);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // collect closes over props; re-run when any displayed input changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspace, permissionMode, selectedModel, settings]);

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} stacked className="max-w-lg">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-bg-300 px-6 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="h-4 w-4 text-accent" />
          <DialogTitle className="text-base font-semibold">{t.modalTitle}</DialogTitle>
        </div>
        <div className="-mr-1.5 flex items-center gap-1">
          <Button
            variant="ghost"
            icon
            onClick={() => {
              setLoading(true);
              void collect()
                .then(setSections)
                .finally(() => setLoading(false));
            }}
            aria-label={t.refresh}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="ghost" icon data-dialog-close onClick={onClose} aria-label={t.close}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
        {!sections && loading && <p className="text-sm text-text-400">{t.analyzing}</p>}
        {sections?.map((section) => (
          <div key={section.title}>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-500">{section.title}</p>
            <div className="space-y-2">
              {section.checks.map((check, i) => {
                const Icon = STATUS_ICON[check.status];
                return (
                  <div key={i} className="flex items-start gap-2.5">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${STATUS_COLOR[check.status]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-text-200">{check.label}</span>
                        <span className="truncate text-right text-sm font-medium text-text-100" data-tooltip={check.value}>
                          {check.value}
                        </span>
                      </div>
                      {check.details && check.details.length > 0 && (
                        <ul className="mt-0.5 space-y-0.5 text-[12px] text-text-400">
                          {check.details.map((d, j) => (
                            <li key={j} className="break-words">{d}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <SaveLogsFooter />
    </Dialog>
  );
}

/** Help › Troubleshooting › Save logs, as in Claude Code Desktop: everything support needs in
 *  one zip. */
function SaveLogsFooter() {
  const t = useTranslations().logs;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ path: string; files: number } | null>(null);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await saveLogsZip();
      if (res) setDone(res);
    } catch (e) {
      setError(localizedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-bg-300 px-6 py-3">
      <p className="min-w-0 flex-1 text-[12.5px] text-text-400">
        {error ? (
          <span className="text-red-500">{error}</span>
        ) : done ? (
          <>
            {t.saved.replace("{n}", String(done.files))}{" "}
            <button type="button" onClick={() => void invoke("agent_reveal_path", { path: done.path }).catch(() => undefined)} className="text-[color:var(--link)] hover:underline">
              {t.showFile}
            </button>
          </>
        ) : (
          t.hint
        )}
      </p>
      <Button onClick={() => void run()} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {t.save}
      </Button>
    </footer>
  );
}

export default DoctorModal;
