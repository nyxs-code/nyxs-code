import { useEffect, useState } from "react";
import {
  Check, Folder, Loader2, MoreHorizontal, Trash2,
} from "lucide-react";
import { invoke } from "@/lib/ipc";
import { localizedError, useTranslations, getLanguage } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import {
  checkPluginUpdates, isBuiltinMarketplace, refreshMarketplace, setEnabled, uninstallPlugin, updatePlugin,
} from "@/lib/plugins";
import { clearPluginLoaderCache } from "@/lib/plugins/pluginLoader";
import { UserConfigDialog, type PluginRowState } from "@/components/PluginsModal";
import { getPluginConfigForEdit, hasUserConfig, validateUserConfig } from "@/lib/plugins/userConfig";
import { cn } from "@/lib/utils";
import { PluginLogo } from "./logos";
import { CountBadge, Dropdown, MenuItem, MenuSeparator } from "./ui";
import { notifyPluginsChanged, type PluginItem } from "./usePluginsData";

export type PluginSort = "recent" | "name";
export type PluginFilter = "all" | "plugins" | "skills" | "on" | "off";

const DAY = 86_400_000;

function shortDate(ms: number, now: number, agoDays: string): string {
  const days = Math.floor((now - ms) / DAY);
  if (days < 7) return agoDays.replace("{n}", String(Math.max(days, 0)));
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(getLanguage(), sameYear ? { day: "numeric", month: "short" } : { month: "short", year: "numeric" });
}

function Chip({ children, tone = "gray" }: { children: React.ReactNode; tone?: "gray" | "blue" | "accent" }) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center h-[18px] px-1.5 rounded-[5px] text-[11px]",
        tone === "blue" && "bg-blue-500/10 text-blue-500 font-medium",
        tone === "accent" && "bg-accent/10 text-accent font-medium",
        tone === "gray" && "bg-bg-200 text-text-400",
      )}
    >
      {children}
    </span>
  );
}

function PluginRow({
  item,
  onError,
}: {
  item: PluginItem;
  onError: (msg: string | null) => void;
}) {
  const tr = useTranslations();
  const t = tr.customizePage;
  const [busy, setBusy] = useState(false);
  const [confirm, confirmElement] = useConfirm();
  const [now] = useState(() => Date.now());
  const isNew = item.installedAt !== undefined && now - item.installedAt < 3 * DAY;
  const extra = item.keywords.length;

  const origin =
    item.kind === "skill"
      ? item.group === "project"
        ? t.originProject
        : item.group === "user"
          ? t.originYou
          : t.originNyxs
      : item.author
        ? t.byDeveloper.replace("{name}", item.author)
        : t.byDeveloper.replace("{name}", item.group);

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

  const [config, setConfig] = useState<{ enableAfter: boolean } | null>(null);
  const configRow: PluginRowState | null =
    item.installed && item.manifest ? { installed: item.installed, manifest: item.manifest, enabled: item.enabled } : null;

  const uninstall = async () => {
    const p = item.installed;
    if (!p) return;
    const ok = await confirm({
      title: tr.pluginsModal.uninstallConfirm.replace("{name}", item.name),
      confirmLabel: tr.pluginsModal.uninstall,
      cancelLabel: tr.pluginsModal.cancel,
      danger: true,
    });
    if (ok) await run(() => uninstallPlugin(p.id));
  };

  /** Updating reinstalls the plugin turned on; one the user had turned off stays off. */
  const update = async (id: string) => {
    await updatePlugin(id);
    if (!item.enabled) await setEnabled(id, false);
  };

  // What the last update check found, shown in place of the date for a few seconds.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [notice]);

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
      await update(p.id);
      setNotice(found.kind === "version" ? t.updatedTo.replace("{version}", found.latest) : t.updated);
    });
  };

  const openFolder = () => {
    const dir = item.installed?.installLocation ?? item.skill?.dir;
    if (dir) void invoke("agent_open_path", { path: dir }).catch(() => undefined);
  };

  return (
    <div className="group flex items-center gap-4 py-3 border-b border-bg-300">
      <PluginLogo
        name={item.name}
        hints={`${item.category ?? ""} ${item.keywords.join(" ")} ${item.kind === "skill" ? "skill" : ""} ${item.description.slice(0, 120)}`}
        size={36}
        className={cn(!item.enabled && "opacity-50 grayscale")}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("text-[14px] font-medium truncate", item.enabled ? "text-text-100" : "text-text-300")}>
            {item.name}
          </span>
          {isNew && <Chip tone="blue">{t.badgeNew}</Chip>}
          {item.category && <Chip>{item.category}</Chip>}
          {extra > 0 && <Chip>+{extra}</Chip>}
          {item.kind === "skill" && <Chip>{t.badgeSkill}</Chip>}
          {!item.enabled && <Chip>{t.badgeDisabled}</Chip>}
          {item.update && <Chip tone="accent">{t.badgeUpdate}</Chip>}
        </div>
        <p className="text-[13px] text-text-400 truncate mt-0.5">
          {origin}
          {item.description && <span className="mx-1.5">·</span>}
          {item.description}
        </p>
      </div>
      {notice ? (
        <span className="shrink-0 inline-flex items-center gap-1 text-[13px] text-green-500">
          <Check className="w-3.5 h-3.5" />
          {notice}
        </span>
      ) : item.installedAt !== undefined && (
        <span className="shrink-0 text-[13px] text-text-400 tabular-nums">
          {shortDate(item.installedAt, now, t.daysAgo)}
        </span>
      )}
      {busy ? (
        <span className="w-8 h-8 flex items-center justify-center">
          <Loader2 className="w-4 h-4 text-text-400 animate-spin" />
        </span>
      ) : (
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
            // The same three entries as Claude's menu. "Configure…" only shows for the rare
            // plugin that has settings of its own (an API key…), which nothing else can edit.
            item.installed ? (
              <>
                <MenuItem label={item.enabled ? t.turnOff : t.turnOn} onClick={() => { close(); void toggle(); }} />
                <MenuItem label={t.checkUpdates} onClick={() => { close(); void checkForUpdates(); }} />
                {configRow && hasUserConfig(configRow.manifest!) && (
                  <MenuItem label={t.configure} onClick={() => { close(); setConfig({ enableAfter: false }); }} />
                )}
                <MenuSeparator />
                <MenuItem danger icon={<Trash2 className="w-4 h-4" />} label={t.uninstall} onClick={() => { close(); void uninstall(); }} />
              </>
            ) : (
              <MenuItem label={t.openFolder} onClick={() => { close(); openFolder(); }} />
            )
          )}
        </Dropdown>
      )}
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
    </div>
  );
}

function Section({
  title,
  items,
  right,
  empty,
  onError,
}: {
  title: string;
  items: PluginItem[];
  right?: React.ReactNode;
  empty?: string;
  onError: (msg: string | null) => void;
}) {
  return (
    <section className="mb-10">
      <div className="flex items-center gap-2 mb-1 min-h-8">
        <h2 className="text-[15px] font-medium text-text-100">{title}</h2>
        <CountBadge n={items.length} />
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {items.length === 0 && empty ? (
        <div className="flex items-center gap-4 py-3">
          <span className="w-9 h-9 shrink-0 rounded-[8px] border border-bg-300 flex items-center justify-center text-text-400">
            <Folder className="w-4 h-4" />
          </span>
          <p className="text-[14px] text-text-300">{empty}</p>
        </div>
      ) : (
        items.map((it) => <PluginRow key={it.key} item={it} onError={onError} />)
      )}
    </section>
  );
}

/** The installed plugins and skills, grouped by where they come from. */
export function PluginsTab({
  items,
  error,
  onError,
  query,
  sort,
  filter,
  workspace,
}: {
  items: PluginItem[] | null;
  error: string | null;
  onError: (msg: string | null) => void;
  query: string;
  sort: PluginSort;
  filter: PluginFilter;
  workspace: string | null;
}) {
  const t = useTranslations().customizePage;

  if (items === null) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-[13px] text-text-400">
        <Loader2 className="w-4 h-4 animate-spin" /> {t.loading}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const visible = items
    .filter((it) => !q || `${it.name} ${it.description} ${it.category ?? ""} ${it.keywords.join(" ")}`.toLowerCase().includes(q))
    .filter((it) =>
      filter === "plugins" ? it.kind === "plugin"
        : filter === "skills" ? it.kind === "skill"
          : filter === "on" ? it.enabled
            : filter === "off" ? !it.enabled
              : true,
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : (b.installedAt ?? 0) - (a.installedAt ?? 0) || a.name.localeCompare(b.name),
    );

  const project = visible.filter((it) => it.kind === "skill" && it.group === "project");
  const mine = visible.filter((it) => it.kind === "skill" && it.group === "user");
  const builtin = visible.filter((it) => it.kind === "skill" && it.group === "builtin");
  const plugins = visible.filter((it) => it.kind === "plugin");
  const marketplaces = [...new Set(plugins.map((p) => p.group))].sort(
    (a, b) => Number(isBuiltinMarketplace(b)) - Number(isBuiltinMarketplace(a)) || a.localeCompare(b),
  );
  const folderName = workspace?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const common = { onError };

  return (
    <div className="pb-10">
      {error && <p className="text-[13px] text-red-400 mb-4 break-words">{error}</p>}
      <Section
        title={t.inThisProject}
        items={project}
        empty={workspace ? t.noProjectPlugins : t.noProjectOpen}
        right={
          folderName && (
            <span className="inline-flex items-center gap-2 h-8 px-3 rounded-[6px] border border-bg-300 text-[13px] text-text-200 shadow-sm">
              <Folder className="w-3.5 h-3.5 text-text-400" />
              {folderName}
            </span>
          )
        }
        {...common}
      />
      {mine.length > 0 && <Section title={t.createdByYou} items={mine} {...common} />}
      {marketplaces.map((m) => (
        <Section
          key={m}
          title={isBuiltinMarketplace(m) ? t.fromAnthropic : t.fromMarketplace.replace("{name}", m)}
          items={plugins.filter((p) => p.group === m)}
          {...common}
        />
      ))}
      {builtin.length > 0 && <Section title={t.includedInNyxs} items={builtin} {...common} />}
      {visible.length === 0 && q && <p className="py-6 text-[13px] text-text-400">{t.noResults}</p>}
    </div>
  );
}
