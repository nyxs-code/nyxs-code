import { useCallback, useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";
import { useTranslations } from "@/lib/i18n";
import {
  X,
  Power,
  Trash2,
  SlidersHorizontal,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Plug,
  ChevronRight,
} from "lucide-react";
import { listInstalled, uninstallPlugin, setEnabled } from "@/lib/plugins/install";
import { getEnabledPlugins } from "@/lib/plugins/pluginSettings";
import { clearPluginLoaderCache } from "@/lib/plugins/pluginLoader";
import { validatePlugin, type ValidationReport } from "@/lib/plugins/validate";
import {
  getPluginConfigForEdit,
  setPluginConfig,
  validateUserConfig,
  hasUserConfig,
} from "@/lib/plugins/userConfig";
import { parsePluginManifest, type InstalledPlugin, type PluginManifest } from "@/lib/plugins/schema";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/lib/useConfirm";

interface PluginsModalProps {
  open: boolean;
  onClose: () => void;
}

interface Row {
  installed: InstalledPlugin;
  manifest: PluginManifest | null;
  enabled: boolean;
}

async function readManifest(installLocation: string): Promise<PluginManifest | null> {
  for (const p of [`${installLocation}/.nyxs-plugin/plugin.json`, `${installLocation}/plugin.json`]) {
    try {
      const raw = await invoke<string>("nyxs_read_text", { path: p });
      if (raw.trim()) return parsePluginManifest(JSON.parse(raw)).manifest;
    } catch {
      /* try next */
    }
  }
  return null;
}

function contributionParts(m: PluginManifest | null): string[] {
  if (!m) return [];
  const parts: string[] = [];
  if (m.commands) parts.push("commands");
  if (m.agents) parts.push("agents");
  if (m.skills) parts.push("skills");
  if (m.outputStyles) parts.push("output-styles");
  if (m.hooks) parts.push("hooks");
  if (m.mcpServers) parts.push("mcp");
  return parts;
}

export function PluginsModal({ open, onClose }: PluginsModalProps) {
  const tr = useTranslations();
  const t = tr.pluginsModal;
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, ValidationReport>>({});
  const [configFor, setConfigFor] = useState<Row | null>(null);
  // The settings were asked for to turn the plugin on: saving them turns it on.
  const [enableAfterConfig, setEnableAfterConfig] = useState(false);
  const [confirm, confirmElement] = useConfirm();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [installed, enabledIds] = await Promise.all([listInstalled(), getEnabledPlugins()]);
      const enabledSet = new Set(enabledIds);
      const withManifests = await Promise.all(
        installed.map(async (installed) => ({
          installed,
          manifest: await readManifest(installed.installLocation),
          enabled: enabledSet.has(installed.id),
        })),
      );
      setRows(withManifests);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void Promise.resolve().then(reload);
  }, [open, reload]);

  if (!open) return null;

  const toggle = async (row: Row) => {
    if (!row.enabled) {
      const ok = await confirm({
        title: t.enableConfirmTitle.replace("{name}", row.manifest?.name ?? row.installed.plugin),
        message: t.enableConfirmBody,
        confirmLabel: t.enable,
        cancelLabel: t.cancel,
      });
      if (!ok) return;
      if (row.manifest && hasUserConfig(row.manifest)) {
        const values = await getPluginConfigForEdit(row.installed.id, row.manifest);
        if (validateUserConfig(row.manifest, values).length) {
          setEnableAfterConfig(true);
          setConfigFor(row);
          return;
        }
      }
    }
    setBusy(row.installed.id);
    try {
      await setEnabled(row.installed.id, !row.enabled);
      clearPluginLoaderCache();
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: Row) => {
    const ok = await confirm({
      title: t.uninstallConfirm.replace("{name}", row.manifest?.name ?? row.installed.plugin),
      confirmLabel: t.uninstall,
      cancelLabel: t.cancel,
      danger: true,
    });
    if (!ok) return;
    setBusy(row.installed.id);
    try {
      await uninstallPlugin(row.installed.id);
      clearPluginLoaderCache();
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const validate = async (row: Row) => {
    setBusy(row.installed.id);
    try {
      const report = await validatePlugin(row.installed.installLocation);
      setReports((r) => ({ ...r, [row.installed.id]: report }));
      setExpanded(row.installed.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        className="max-h-[85vh] max-w-2xl overflow-hidden border-zinc-700 bg-zinc-900 text-zinc-100"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-amber-400" />
            <DialogTitle className="text-base font-semibold text-zinc-100">Plugins</DialogTitle>
          </div>
          <button
            onClick={onClose}
            aria-label={tr.modals.close}
            data-dialog-close
            className="rounded-[6px] p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /> {t.loading}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-zinc-400">
              {t.empty}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row) => {
                const id = row.installed.id;
                const name = row.manifest?.name ?? row.installed.plugin;
                const report = reports[id];
                const isExpanded = expanded === id;
                return (
                  <li key={id} className="rounded-[8px] border border-zinc-800 bg-zinc-850/40">
                    <div className="flex items-center gap-3 p-3">
                      <button
                        onClick={() => setExpanded(isExpanded ? null : id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <ChevronRight
                          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{name}</span>
                            <span className="shrink-0 text-xs text-zinc-500">
                              {row.installed.version} · {row.installed.marketplace}
                            </span>
                          </div>
                          <div className="truncate text-xs text-zinc-500">
                            {!row.manifest
                              ? t.noManifest
                              : contributionParts(row.manifest).length
                                ? contributionParts(row.manifest).join(" · ")
                                : t.noComponents}
                          </div>
                        </div>
                      </button>

                      <div className="flex shrink-0 items-center gap-1">
                        {busy === id && <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />}
                        {row.manifest && hasUserConfig(row.manifest) && (
                          <button
                            aria-label={t.configure}
                            data-tooltip={t.configure}
                            onClick={() => {
                              setEnableAfterConfig(false);
                              setConfigFor(row);
                            }}
                            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                          >
                            <SlidersHorizontal className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          aria-label={row.enabled ? t.disable : t.enable}
                          data-tooltip={row.enabled ? t.disable : t.enable}
                          onClick={() => void toggle(row)}
                          className={`rounded-md p-1.5 hover:bg-zinc-800 ${row.enabled ? "text-emerald-400" : "text-zinc-500"}`}
                        >
                          <Power className="h-4 w-4" />
                        </button>
                        <button
                          aria-label={t.uninstall}
                          data-tooltip={t.uninstall}
                          onClick={() => void remove(row)}
                          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="border-t border-zinc-800 px-4 py-3 text-xs">
                        {row.manifest?.description && (
                          <p className="mb-2 text-zinc-300">{row.manifest.description}</p>
                        )}
                        <div className="mb-3 flex flex-wrap gap-1.5">
                          {contributionParts(row.manifest).map((c) => (
                            <span key={c} className="rounded-[6px] bg-zinc-800 px-2 py-0.5 text-zinc-300">
                              {c}
                            </span>
                          ))}
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => void validate(row)}
                            className="rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-300 hover:bg-zinc-800"
                          >
                            {t.validate}
                          </button>
                          {report && (
                            <span
                              className={`flex items-center gap-1 ${report.ok ? "text-emerald-400" : "text-amber-400"}`}
                            >
                              {report.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                              {report.ok ? t.valid : t.issues.replace("{count}", String(report.errors.length))}
                            </span>
                          )}
                        </div>
                        {report && report.errors.length > 0 && (
                          <ul className="mt-2 space-y-1 text-red-300">
                            {report.errors.map((e, i) => (
                              <li key={i}>• {e.path ? `${e.path}: ` : ""}{e.message}</li>
                            ))}
                          </ul>
                        )}
                        {report && report.warnings.map((w, i) => (
                          <p key={i} className="mt-1 text-amber-300/80">⚠ {w}</p>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-zinc-800 px-5 py-3 text-xs text-zinc-500">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          {t.trustNote}
        </div>
      </Dialog>

      {/* A sibling, not a child: a click on its backdrop must not reach this dialog's. */}
      {configFor && (
        <UserConfigDialog
          row={configFor}
          onClose={() => setConfigFor(null)}
          onSaved={async () => {
            const row = configFor;
            setConfigFor(null);
            if (enableAfterConfig && !row.enabled) await setEnabled(row.installed.id, true);
            clearPluginLoaderCache();
            await reload();
          }}
        />
      )}
      {confirmElement}
    </>
  );
}

function UserConfigDialog({
  row,
  onClose,
  onSaved,
}: {
  row: Row;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations().pluginsModal;
  const manifest = row.manifest;
  const [values, setValues] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (manifest) void getPluginConfigForEdit(row.installed.id, manifest).then(setValues);
  }, [row.installed.id, manifest]);

  if (!manifest) return null;
  const options = Object.entries(manifest.userConfig ?? {});

  const save = async () => {
    const miss = validateUserConfig(manifest, values);
    setMissing(miss);
    if (miss.length) return;
    setSaving(true);
    try {
      await setPluginConfig(row.installed.id, manifest, values);
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} stacked className="overflow-y-auto border-zinc-700 bg-zinc-900 p-5 text-zinc-100">
      <DialogTitle className="mb-1 text-sm font-semibold text-zinc-100">
        {t.configureTitle.replace("{name}", manifest.name)}
      </DialogTitle>
      <p className="mb-4 text-xs text-zinc-500">{t.configureNote}</p>
      <div className="flex flex-col gap-3">
        {options.map(([key, opt]) => (
          <label key={key} className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-zinc-300">
              {opt.title || key}
              {opt.required && <span className="text-red-400"> *</span>}
            </span>
            {opt.description && <span className="text-zinc-500">{opt.description}</span>}
            {opt.type === "boolean" ? (
              <select
                value={values[key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                className="rounded-[6px] border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
              >
                <option value="">—</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type={opt.sensitive ? "password" : opt.type === "number" ? "number" : "text"}
                value={values[key] ?? ""}
                placeholder={opt.default !== undefined ? String(opt.default) : ""}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                className={`rounded-[6px] border bg-zinc-800 px-2 py-1.5 text-sm ${
                  missing.includes(key) ? "border-red-500" : "border-zinc-700"
                }`}
              />
            )}
          </label>
        ))}
      </div>
      {missing.length > 0 && (
        <p className="mt-3 text-xs text-red-400">{t.fillRequired}</p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
          {t.cancel}
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={saving}
          className="bg-amber-500 text-zinc-900 hover:bg-amber-400 focus-visible:ring-amber-500"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t.save}
        </Button>
      </div>
    </Dialog>
  );
}
