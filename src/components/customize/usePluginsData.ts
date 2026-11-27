import { useCallback, useEffect, useRef, useState } from "react";
import {
  listInstalled, listMarketplaces, getCatalog, checkPluginUpdates, isBuiltinMarketplace,
  type CatalogPlugin, type InstalledPlugin, type KnownMarketplace, type PluginUpdate,
} from "@/lib/plugins";
import { getEnabledPlugins } from "@/lib/plugins/pluginSettings";
import { describePlugin, sourceOf, type PluginParts } from "@/lib/plugins/pluginDetails";
import type { PluginManifest } from "@/lib/plugins/schema";
import { loadSkills, type SkillDef } from "@/lib/skills";
import { readManifest } from "@/lib/plugins/manifestFile";

/** Sent after a plugin is installed, removed, turned on or off, or a marketplace is added,
 *  so every list of plugins on screen reads them again. */
export const PLUGINS_CHANGED_EVENT = "nyxs:plugins-changed";

export function notifyPluginsChanged(): void {
  window.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT));
}

export type PluginItem = {
  key: string;
  kind: "plugin" | "skill";
  name: string;
  description: string;
  category?: string;
  keywords: string[];
  /** Who made it, for the "By …" line: the plugin's author or the marketplace. */
  author?: string;
  /** "project" | "user" | "builtin" for skills, the marketplace's name for plugins. */
  group: string;
  installedAt?: number;
  enabled: boolean;
  installed?: InstalledPlugin;
  manifest?: PluginManifest | null;
  update?: PluginUpdate;
  skill?: SkillDef;
  /** What the plugin adds (hooks, commands, agents, skills, MCP servers…). */
  parts?: PluginParts;
  /** Its marketplace's entry for it. */
  catalog?: CatalogPlugin;
  /** Where its code lives: its repository, or its marketplace's. */
  source?: { label: string; url: string | null } | null;
  /** From Anthropic's official marketplace. */
  verified?: boolean;
};

/** The installed plugins (with what their marketplace says of them) and the skills on disk. */
export function usePluginsData(workspace: string | null) {
  const [items, setItems] = useState<PluginItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [installed, enabledIds, skills, known] = await Promise.all([
        listInstalled().catch(() => [] as InstalledPlugin[]),
        getEnabledPlugins().catch(() => [] as string[]),
        loadSkills(workspace).catch(() => [] as SkillDef[]),
        listMarketplaces().catch(() => [] as KnownMarketplace[]),
      ]);
      const enabled = new Set(enabledIds);
      const marketplaces = [...new Set(installed.map((p) => p.marketplace))];
      const catalogs = new Map<string, CatalogPlugin[]>();
      await Promise.all(
        marketplaces.map(async (m) => {
          try {
            catalogs.set(m, (await getCatalog(m)).plugins);
          } catch {
            /* the list still shows the plugin, without its catalog details */
          }
        }),
      );
      const [manifests, parts] = await Promise.all([
        Promise.all(installed.map((p) => readManifest(p.installLocation).catch(() => null))),
        Promise.all(installed.map((p) => describePlugin(p).catch(() => undefined))),
      ]);
      const plugins: PluginItem[] = installed.map((p, i) => {
        const cat = catalogs.get(p.marketplace)?.find((c) => c.name === p.plugin);
        const manifest = manifests[i];
        return {
          parts: parts[i],
          catalog: cat,
          source: sourceOf(manifest, cat?.homepage, known.find((m) => m.name === p.marketplace)),
          verified: isBuiltinMarketplace(p.marketplace),
          key: `plugin:${p.id}`,
          kind: "plugin",
          name: manifest?.name ?? p.plugin,
          description: manifest?.description || cat?.description || "",
          category: cat?.category,
          keywords: cat?.keywords ?? manifest?.keywords ?? [],
          author: manifest?.author?.name ?? cat?.author,
          group: p.marketplace,
          installedAt: p.installedAt,
          enabled: enabled.has(p.id),
          installed: p,
          manifest,
        };
      });
      const skillItems: PluginItem[] = skills
        .filter((s) => s.source !== "plugin")
        .map((s) => ({
          key: `skill:${s.source}:${s.name}`,
          kind: "skill",
          name: s.name,
          description: s.description,
          keywords: [],
          group: s.source,
          enabled: true,
          skill: s,
        }));
      if (mine !== seq.current) return;
      setItems([...plugins, ...skillItems]);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspace]);

  useEffect(() => {
    void Promise.resolve().then(reload);
    const on = () => void reload();
    window.addEventListener(PLUGINS_CHANGED_EVENT, on);
    return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, on);
  }, [reload]);

  // Updates ask each marketplace for its latest version: slower, so they arrive afterwards.
  const [updates, setUpdates] = useState<PluginUpdate[]>([]);
  const refreshUpdates = useCallback(() => {
    checkPluginUpdates().then(setUpdates).catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshUpdates();
    // An update or uninstall changes what is pending: ask again after each change.
    window.addEventListener(PLUGINS_CHANGED_EVENT, refreshUpdates);
    return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, refreshUpdates);
  }, [refreshUpdates]);

  const byId = new Map(updates.map((u) => [u.id, u]));
  const withUpdates = items?.map((it) => (it.installed && byId.has(it.installed.id) ? { ...it, update: byId.get(it.installed.id) } : it)) ?? null;

  return { items: withUpdates, error, setError, reload, refreshUpdates };
}
