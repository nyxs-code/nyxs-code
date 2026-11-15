import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { warmModelRegistry } from "@/lib/ai";
import { agentCliDefaultEnabled, agentCliOf, fetchAgentCliModels, hasAgentCliPlaceholder, AGENT_CLI_PROVIDERS } from "@/lib/agentCli";
import { fetchClaudeCodeModels, startClaudeCodeMaintenance } from "@/lib/claudeCode";
import { listenForRequests, startMcpBridge } from "@/lib/mcpBridge";
import { PROVIDERS, type ProviderId } from "@/lib/models";
import { fetchProviderModelsWithRetry } from "@/lib/providerModels";
import { saveSettings, type Settings } from "@/lib/settings";

/** Keeps the settings saved and every connected provider's model list up to date: Claude Code
 *  and the agent CLIs read again once per app run, API providers fetched when they have a key
 *  but no list yet. */
export function useProviderModels(settings: Settings, setSettings: Dispatch<SetStateAction<Settings>>) {
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => { void warmModelRegistry(); }, []);

  const claudeModelsRefreshed = useRef(false);
  const claudeCodeReady = Boolean(settings["claude-code"]?.apiKey?.trim() && settings["claude-code"]?.models?.length);
  useEffect(() => {
    if (!claudeCodeReady || claudeModelsRefreshed.current) return;
    claudeModelsRefreshed.current = true;
    void fetchClaudeCodeModels().then(
      (models) =>
        setSettings((prev) => {
          const cfg = prev["claude-code"];
          const valid = new Set(models.map((m) => m.id));
          return { ...prev, "claude-code": { ...cfg, models, enabled: (cfg.enabled ?? []).filter((id) => valid.has(id)) } };
        }),
      () => { /* keep the saved list */ },
    );
  }, [claudeCodeReady, setSettings]);
  useEffect(() => (claudeCodeReady ? startClaudeCodeMaintenance() : undefined), [claudeCodeReady]);

  // The agent CLIs: their model lists (names, context windows, reasoning levels) read again
  // once per app run, which also drops the stand-in an older list kept.
  const cliModelsRefreshed = useRef(new Set<ProviderId>());
  const connectedClis = (Object.keys(AGENT_CLI_PROVIDERS) as ProviderId[]).filter((id) => settings[id]?.apiKey?.trim()).join(",");
  // DeepSeek Harness lists the models its API key gives access to.
  const deepseekCliKey = settings["deepseek-cli"]?.apiKey;
  // Their bridge to Nyxs' own tools listens from the start: Antigravity may call the browser
  // as soon as it runs, before anything in this page asked for the bridge.
  useEffect(() => {
    listenForRequests();
    if (connectedClis) void startMcpBridge().catch(() => undefined);
  }, [connectedClis]);
  useEffect(() => {
    for (const id of connectedClis.split(",").filter(Boolean) as ProviderId[]) {
      const cli = agentCliOf(id);
      if (!cli || cliModelsRefreshed.current.has(id)) continue;
      cliModelsRefreshed.current.add(id);
      void fetchAgentCliModels(cli, id === "deepseek-cli" ? deepseekCliKey : undefined).then((models) => {
        // Nothing listed (not signed in, CLI gone): the saved list stays.
        if (hasAgentCliPlaceholder(models)) return;
        setSettings((prev) => {
          const cfg = prev[id];
          const valid = new Set(models.map((m) => m.id));
          const kept = (cfg.enabled ?? []).filter((mid) => valid.has(mid));
          return { ...prev, [id]: { ...cfg, models, enabled: kept.length ? kept : agentCliDefaultEnabled(models) } };
        });
      });
    }
  }, [connectedClis, deepseekCliKey, setSettings]);

  // A provider whose list came back empty or failed isn't asked again this run.
  const modelLoadAttempted = useRef<Set<ProviderId>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
        if (cancelled) return;
        const cfg = settings[id];
        if (!cfg?.apiKey?.trim() || cfg.models?.length || modelLoadAttempted.current.has(id)) continue;
        try {
          const models = await fetchProviderModelsWithRetry(PROVIDERS[id], cfg);
          if (cancelled) return;
          if (models.length === 0) {
            modelLoadAttempted.current.add(id);
            continue;
          }
          setSettings((prev) => {
            const valid = new Set(models.map((m) => m.id));
            const enabled = (prev[id].enabled ?? []).filter((mid) => valid.has(mid));
            return { ...prev, [id]: { ...prev[id], models, enabled } };
          });
        } catch {
          modelLoadAttempted.current.add(id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings, setSettings]);
}
