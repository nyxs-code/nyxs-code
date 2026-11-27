import { Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem, MenuSeparator } from "./ui";
import type { usePluginActions } from "./usePluginActions";
import type { PluginItem } from "./usePluginsData";

/** A plugin's or skill's ⋮ menu, the same entries as Claude's; a spinner while an action runs. */
export function PluginMenu({
  item,
  actions,
  withFolder,
  onRemoved,
}: {
  item: PluginItem;
  actions: ReturnType<typeof usePluginActions>;
  /** Also "Open folder", on the plugin's page. */
  withFolder?: boolean;
  onRemoved?: () => void;
}) {
  const t = useTranslations().customizePage;
  if (actions.busy) {
    return (
      <span className="w-8 h-8 shrink-0 flex items-center justify-center">
        <Loader2 className="w-4 h-4 text-text-400 animate-spin" />
      </span>
    );
  }
  return (
    <Dropdown
      trigger={(open, toggleMenu) => (
        <button
          type="button"
          onClick={toggleMenu}
          aria-label={t.moreOptions}
          className={cn(
            "w-8 h-8 shrink-0 rounded-[6px] flex items-center justify-center text-text-400 hover:bg-bg-200 hover:text-text-100",
            open && "bg-bg-200 text-text-100",
          )}
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      )}
    >
      {(close) => (
        // "Configure…" only shows for the rare plugin that has settings of its own (an API key…),
        // which nothing else can edit.
        item.installed ? (
          <>
            <MenuItem label={item.enabled ? t.turnOff : t.turnOn} onClick={() => { close(); void actions.toggle(); }} />
            <MenuItem label={t.checkUpdates} onClick={() => { close(); void actions.checkForUpdates(); }} />
            {actions.configurable && (
              <MenuItem label={t.configure} onClick={() => { close(); actions.configure(); }} />
            )}
            {withFolder && <MenuItem label={t.openFolder} onClick={() => { close(); actions.openFolder(); }} />}
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash2 className="w-4 h-4" />}
              label={t.uninstall}
              onClick={() => { close(); void actions.uninstall().then((gone) => { if (gone) onRemoved?.(); }); }}
            />
          </>
        ) : (
          <MenuItem label={t.openFolder} onClick={() => { close(); actions.openFolder(); }} />
        )
      )}
    </Dropdown>
  );
}
