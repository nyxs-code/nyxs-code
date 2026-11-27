import { useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";
import { localizedError, useTranslations } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import { checkPluginUpdates, refreshMarketplace, setEnabled, uninstallPlugin, updatePlugin } from "@/lib/plugins";
import { clearPluginLoaderCache } from "@/lib/plugins/pluginLoader";
import { getPluginConfigForEdit, hasUserConfig, validateUserConfig } from "@/lib/plugins/userConfig";
import { UserConfigDialog, type PluginRowState } from "@/components/PluginsModal";
import { notifyPluginsChanged, type PluginItem } from "./usePluginsData";

/**
 * What can be done with an installed plugin or a skill, shared by its row in the list and its
 * page: turn it on or off (asking first, and for its settings when it needs them), update it,
 * configure it, remove it, open its folder. `dialogs` holds the confirmations and the settings
 * dialog, to render next to the controls.
 */
export function usePluginActions(item: PluginItem, onError: (msg: string | null) => void) {
  const tr = useTranslations();
  const t = tr.customizePage;
  const [busy, setBusy] = useState(false);
  const [confirm, confirmElement] = useConfirm();
  const [config, setConfig] = useState<{ enableAfter: boolean } | null>(null);
  // What the last update check found, shown for a few seconds.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const configRow: PluginRowState | null =
    item.installed && item.manifest ? { installed: item.installed, manifest: item.manifest, enabled: item.enabled } : null;
  const configurable = !!item.manifest && hasUserConfig(item.manifest);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await action();
      clearPluginLoaderCache();
      notifyPluginsChanged();
    } catch (e) {
      onError(localizedError(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    const p = item.installed;
    if (!p) return;
    if (!item.enabled) {
      // Turning a plugin on lets its hooks and servers run: ask first, as the plugins dialog does.
      const ok = await confirm({
        title: tr.pluginsModal.enableConfirmTitle.replace("{name}", item.name),
        message: tr.pluginsModal.enableConfirmBody,
        confirmLabel: tr.pluginsModal.enable,
        cancelLabel: tr.pluginsModal.cancel,
      });
      if (!ok) return;
      // A plugin that needs settings (an API key…) asks for them before it turns on.
      const m = item.manifest;
      if (m && hasUserConfig(m) && validateUserConfig(m, await getPluginConfigForEdit(p.id, m)).length) {
        setConfig({ enableAfter: true });
        return;
      }
    }
    await run(() => setEnabled(p.id, !item.enabled));
  };

  /** Updating reinstalls the plugin turned on; one the user had turned off stays off. */
  const install = async (id: string) => {
    await updatePlugin(id);
    if (!item.enabled) await setEnabled(id, false);
  };

  /** Installs the newer version the list already found. */
  const update = async () => {
    const p = item.installed;
    if (!p || !item.update) return;
    const found = item.update;
    await run(async () => {
      await install(p.id);
      setNotice(found.kind === "version" ? t.updatedTo.replace("{version}", found.latest) : t.updated);
    });
  };

  /** Reads the plugin's marketplace again and installs its newer version, if there is one. */
  const checkForUpdates = async () => {
    const p = item.installed;
    if (!p) return;
    setNotice(null);
    await run(async () => {
      await refreshMarketplace(p.marketplace);
      const found = (await checkPluginUpdates()).find((u) => u.id === p.id);
      if (!found) {
        setNotice(t.upToDate);
        return;
      }
      await install(p.id);
      setNotice(found.kind === "version" ? t.updatedTo.replace("{version}", found.latest) : t.updated);
    });
  };

  const uninstall = async (): Promise<boolean> => {
    const p = item.installed;
    if (!p) return false;
    const ok = await confirm({
      title: tr.pluginsModal.uninstallConfirm.replace("{name}", item.name),
      confirmLabel: tr.pluginsModal.uninstall,
      cancelLabel: tr.pluginsModal.cancel,
      danger: true,
    });
    if (!ok) return false;
    await run(() => uninstallPlugin(p.id));
    return true;
  };

  const openFolder = () => {
    const dir = item.installed?.installLocation ?? item.skill?.dir;
    if (dir) void invoke("agent_open_path", { path: dir }).catch(() => undefined);
  };

  const dialogs = (
    <>
      {confirmElement}
      {config && configRow && (
        <UserConfigDialog
          row={configRow}
          onClose={() => setConfig(null)}
          onSaved={async () => {
            const enableAfter = config.enableAfter;
            setConfig(null);
            await run(async () => {
              if (enableAfter) await setEnabled(configRow.installed.id, true);
            });
          }}
        />
      )}
    </>
  );

  return {
    busy,
    notice,
    configurable,
    toggle,
    update,
    checkForUpdates,
    uninstall,
    openFolder,
    configure: () => setConfig({ enableAfter: false }),
    dialogs,
  };
}
