import { useEffect, useState, useSyncExternalStore } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri } from "@/lib/plugins/paths";
import {
  loadMcpServers,
  saveMcpServers,
  loadMergedMcpServers,
  probeMcpServers,
  stopMcpServer,
  getMcpStatuses,
  subscribeMcpStatuses,
  setOAuthClient,
  type McpServer,
  type McpServerStatus,
  type ConnectorCatalogEntry,
} from "@/lib/mcp";
import { runMcpOAuth } from "@/lib/mcpOAuth";
import { forgetConnectorTokens, saveConnectorTokens } from "@/lib/connectorTokens";
import { localizedError } from "@/lib/i18n";
import type { CustomPrefill } from "@/components/settings/ConnectorDirectory";

const probeDeps = { fetchImpl: tauriFetch as unknown as typeof fetch };

type State = {
  servers: McpServer[];
  /** The connector whose sign-in is open in the browser. */
  connecting: string | null;
  /** The last failed sign-in, prefixed with the connector's name. */
  error: string | null;
  /** The custom-connector form: `null` empty, a value prefilled, `undefined` closed. */
  customPrefill: CustomPrefill | undefined;
};

// One store for the page and the directory dialog over it: a connector added in one shows
// in the other at once.
let state: State = { servers: [], connecting: null, error: null, customPrefill: undefined };
let loaded = false;
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Filled on first read, so the module costs nothing until the page opens.
const getState = () => {
  if (!loaded) {
    loaded = true;
    state = { ...state, servers: loadMcpServers() };
  }
  return state;
};

function persist(next: McpServer[]) {
  saveMcpServers(next);
  set({ servers: next });
}

function stopIfRunning(server: McpServer | undefined) {
  if (isTauri && server) void stopMcpServer(server);
}

export type ManualClient = { clientId: string; clientSecret: string };

/** The user's connectors and what can be done with them, shared by every view of them. */
export function useConnectors() {
  const s = useSyncExternalStore(subscribe, getState);
  const statuses = useSyncExternalStore(subscribeMcpStatuses, getMcpStatuses) as Record<string, McpServerStatus>;
  // Servers from settings files and plugins: shown, not editable here.
  const [configServers] = useState<McpServer[]>(() =>
    loadMergedMcpServers().filter((x) => x.id.startsWith("file:")),
  );

  useEffect(() => {
    // The account may have changed since the store was filled.
    set({ servers: loadMcpServers() });
  }, []);

  useEffect(() => {
    if (isTauri) void probeMcpServers([...s.servers, ...configServers], probeDeps);
  }, [s.servers, configServers]);

  const retry = () => {
    if (isTauri) void probeMcpServers([...state.servers, ...configServers], probeDeps, true);
  };

  const installedUrls = new Set(s.servers.map((x) => x.url));
  const serverFor = (entry: ConnectorCatalogEntry) => s.servers.find((x) => x.url === entry.url);

  const toggle = (id: string) => {
    const target = state.servers.find((x) => x.id === id);
    if (target?.enabled) stopIfRunning(target);
    persist(state.servers.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)));
  };

  const enable = (id: string) => {
    persist(state.servers.map((x) => (x.id === id ? { ...x, enabled: true } : x)));
  };

  const remove = (id: string) => {
    const target = state.servers.find((x) => x.id === id);
    stopIfRunning(target);
    if (target?.oauth) void forgetConnectorTokens(id);
    persist(state.servers.filter((x) => x.id !== id));
  };

  const addServer = (server: McpServer) => {
    persist([...state.servers, server]);
    set({ customPrefill: undefined });
  };

  const openCustom = (prefill: CustomPrefill) => set({ customPrefill: prefill });
  const closeCustom = () => set({ customPrefill: undefined });
  const clearError = () => set({ error: null });

  /**
   * Adds a catalog connector: signs in with OAuth in the browser, asks for a token in the
   * custom form, or just adds it when it needs neither. Resolves to whether it was added.
   */
  const connect = async (
    entry: ConnectorCatalogEntry,
    manual?: ManualClient,
    missingClientMessage = "missing OAuth Client ID",
  ): Promise<boolean> => {
    const existing = state.servers.find((x) => x.url === entry.url);
    if (existing) {
      if (!existing.enabled) enable(existing.id);
      return true;
    }
    if (entry.auth === "token") {
      openCustom({ name: entry.name, url: entry.url });
      return false;
    }
    if (entry.auth === "none") {
      persist([...state.servers, { id: crypto.randomUUID(), name: entry.name, url: entry.url, enabled: true }]);
      return true;
    }
    let clientOpts: { clientId?: string; clientSecret?: string } = {};
    if (entry.oauthManualClient) {
      const builtinId = entry.oauthClientId?.trim();
      if (builtinId) {
        clientOpts = { clientId: builtinId, clientSecret: entry.oauthClientSecret?.trim() };
      } else {
        const cid = manual?.clientId.trim() ?? "";
        if (!cid) {
          set({ error: `${entry.name}: ${missingClientMessage}` });
          return false;
        }
        setOAuthClient(entry.name, { clientId: cid, clientSecret: manual?.clientSecret.trim() ?? "" });
        clientOpts = { clientId: cid, clientSecret: manual?.clientSecret.trim() };
      }
    }
    set({ error: null, connecting: entry.name });
    try {
      const tokens = await runMcpOAuth(entry.url, entry.name, { scopes: entry.oauthScopes, ...clientOpts });
      // The tokens go to the keychain; the connector only says it signs in with OAuth.
      const id = crypto.randomUUID();
      await saveConnectorTokens(id, tokens);
      persist([...state.servers, { id, name: entry.name, url: entry.url, oauth: true, enabled: true }]);
      return true;
    } catch (e) {
      set({ error: `${entry.name}: ${localizedError(e)}` });
      return false;
    } finally {
      set({ connecting: null });
    }
  };

  return {
    servers: s.servers,
    configServers,
    statuses,
    connecting: s.connecting,
    error: s.error,
    customPrefill: s.customPrefill,
    installedUrls,
    serverFor,
    toggle,
    enable,
    remove,
    retry,
    connect,
    addServer,
    openCustom,
    closeCustom,
    clearError,
  };
}

export type Connectors = ReturnType<typeof useConnectors>;
