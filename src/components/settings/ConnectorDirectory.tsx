import { useState, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, ExternalLink, Check, Trash2, Loader2, Plus, Search, ChevronRight, ChevronDown, Copy, TrendingUp, RefreshCw } from "lucide-react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { isTauri } from "@/lib/plugins/paths";
import {
  loadMcpServers,
  saveMcpServers,
  loadMergedMcpServers,
  isStdioServer,
  mcpServerTarget,
  parseCommandLine,
  parseEnvLines,
  probeMcpServers,
  stopMcpServer,
  getMcpStatuses,
  subscribeMcpStatuses,
  CONNECTOR_CATALOG,
  getOAuthClient,
  getOAuthClientSecret,
  setOAuthClient,
  type McpServer,
  type McpServerStatus,
  type ConnectorCatalogEntry,
} from "@/lib/mcp";
import { runMcpOAuth } from "@/lib/mcpOAuth";
import { forgetConnectorTokens, saveConnectorTokens } from "@/lib/connectorTokens";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { localizedError, useTranslations, type Translations } from "@/lib/i18n";

export type CustomPrefill = { name: string; url: string } | null;

export function CustomConnectorModal({
  prefill,
  existingNames,
  onAdd,
  onClose,
}: {
  prefill: CustomPrefill;
  existingNames: string[];
  onAdd: (server: McpServer) => void;
  onClose: () => void;
}) {
  const t = useTranslations().settings;
  const m = t.connectorDetail.mcpStatus;
  const [kind, setKind] = useState<"remote" | "local">("remote");
  const [name, setName] = useState(prefill?.name ?? "");
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [commandLine, setCommandLine] = useState("");
  const [envText, setEnvText] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [headers, setHeaders] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submitLocal = (trimmedName: string) => {
    const parts = parseCommandLine(commandLine.trim());
    if (!trimmedName || parts.length === 0) {
      setError(m.errNameCommand);
      return;
    }
    if (existingNames.includes(trimmedName)) {
      setError(t.errDuplicate.replace("{name}", trimmedName));
      return;
    }
    const env = parseEnvLines(envText);
    if (!env) {
      setError(m.errEnv);
      return;
    }
    onAdd({
      id: crypto.randomUUID(),
      name: trimmedName,
      url: "",
      transport: "stdio",
      command: parts[0],
      args: parts.slice(1),
      env: Object.keys(env).length ? env : undefined,
      enabled: true,
    });
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (kind === "local") {
      submitLocal(trimmedName);
      return;
    }
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl) {
      setError(t.errNameUrl);
      return;
    }
    if (existingNames.includes(trimmedName)) {
      setError(t.errDuplicate.replace("{name}", trimmedName));
      return;
    }
    let parsedHeaders: Record<string, string> | undefined;
    if (headers.trim()) {
      try {
        parsedHeaders = JSON.parse(headers);
      } catch {
        setError(t.errHeadersJson);
        return;
      }
    }
    onAdd({
      id: crypto.randomUUID(),
      name: trimmedName,
      url: trimmedUrl,
      headers: parsedHeaders,
      oauthClientId: clientId.trim() || undefined,
      oauthClientSecret: clientSecret.trim() || undefined,
      enabled: true,
    });
  };

  return (
    <Dialog open onClose={onClose} stacked className="overflow-y-auto custom-scrollbar">
      <DialogHeader className="px-5 pt-5 pb-0">
        <DialogTitle className="text-base font-semibold">{t.addConnector}</DialogTitle>
        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase bg-bg-300 text-text-400">Beta</span>
      </DialogHeader>
      <div className="px-5 pt-3 pb-5 space-y-3">
        <p className="text-[12px] text-text-400">
          {kind === "local" ? m.localHint : t.connectorModalDesc}
        </p>
        {!prefill && (
          <div className="flex gap-1 p-1 rounded-[8px] bg-bg-200 border border-bg-300">
            {(["remote", "local"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => { setKind(k); setError(null); }}
                className={`flex-1 px-3 py-1.5 rounded-[6px] text-xs font-medium transition-colors ${
                  kind === k ? "bg-bg-0 text-text-100" : "text-text-400 hover:text-text-200"
                }`}
              >
                {k === "remote" ? m.remote : m.local}
              </button>
            ))}
          </div>
        )}
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.fieldName}
          className="w-full px-3 py-2 text-sm rounded-[6px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent"
        />
        {kind === "local" ? (
          <>
            <input
              type="text"
              value={commandLine}
              onChange={(e) => setCommandLine(e.target.value)}
              placeholder={m.fieldCommand}
              className="w-full px-3 py-2 text-sm rounded-[6px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono"
            />
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={m.envPlaceholder}
              rows={2}
              className="w-full px-3 py-2 text-xs rounded-[6px] bg-bg-200 border border-bg-300 text-text-300 placeholder:text-text-400 outline-none focus:border-accent font-mono resize-y"
            />
          </>
        ) : (
          <>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t.fieldRemoteUrl}
              className="w-full px-3 py-2 text-sm rounded-[6px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono"
            />

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 text-[12px] text-text-300 hover:text-text-100"
            >
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? "rotate-90" : ""}`} />
              {t.advancedConfig}
            </button>
            {showAdvanced && (
              <div className="space-y-2">
                <textarea
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  placeholder={t.headersPlaceholder}
                  rows={2}
                  className="w-full px-3 py-2 text-xs rounded-[6px] bg-bg-200 border border-bg-300 text-text-300 placeholder:text-text-400 outline-none focus:border-accent font-mono resize-y"
                />
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={t.oauthClientId}
                  className="w-full px-3 py-2 text-xs rounded-[6px] bg-bg-200 border border-bg-300 text-text-300 placeholder:text-text-400 outline-none focus:border-accent font-mono"
                />
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={t.oauthClientSecret}
                  className="w-full px-3 py-2 text-xs rounded-[6px] bg-bg-200 border border-bg-300 text-text-300 placeholder:text-text-400 outline-none focus:border-accent font-mono"
                />
                <p className="text-[11px] text-text-500">
                  {t.oauthInfo}
                </p>
              </div>
            )}
          </>
        )}

        {error && <p className="text-[11px] text-red-400 break-words">{error}</p>}
        <p className="text-[11px] text-text-500">
          {t.trustWarning}
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t.cancel}</Button>
          <Button variant="primary" onClick={submit}>
            {t.add}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ConnectorIcon({ entry, size = 40 }: { entry: ConnectorCatalogEntry; size?: number }) {
  const [failed, setFailed] = useState(false);
  const color = entry.color ?? "#94a3b8";
  const showLogo = entry.logo && !failed;
  return (
    <span
      className="shrink-0 rounded-[8px] flex items-center justify-center overflow-hidden font-bold"
      style={{
        width: size,
        height: size,
        backgroundColor: showLogo ? "#ffffff" : `${color}22`,
        color,
        fontSize: size * 0.42,
      }}
    >
      {showLogo ? (
        <img
          src={entry.logo}
          alt=""
          style={{ width: size * 0.62, height: size * 0.62, objectFit: "contain" }}
          onError={() => setFailed(true)}
        />
      ) : (
        entry.name.charAt(0).toUpperCase()
      )}
    </span>
  );
}

const probeDeps = { fetchImpl: tauriFetch as unknown as typeof fetch };

function useMcpStatuses(): Record<string, McpServerStatus> {
  return useSyncExternalStore(subscribeMcpStatuses, getMcpStatuses);
}

function McpStatusLine({
  server,
  status,
  onRetry,
}: {
  server: McpServer;
  status: McpServerStatus | undefined;
  onRetry: () => void;
}) {
  const m = useTranslations().settings.connectorDetail.mcpStatus;
  if (!server.enabled) return <span className="block text-[11px] text-text-500 mt-0.5">{m.disabled}</span>;
  if (!status) return <span className="block text-[11px] text-text-500 mt-0.5">{m.idle}</span>;
  if (status.state === "connecting") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-text-400 mt-0.5">
        <Loader2 className="w-3 h-3 animate-spin" />
        {m.connecting}
      </span>
    );
  }
  if (status.state === "connected") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-text-300 mt-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        {m.connected.replace("{count}", String(status.toolCount))}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-red-400 mt-0.5">
      <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
      {m.error}
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-0.5 ml-1 text-text-400 hover:text-text-100">
        <RefreshCw className="w-3 h-3" />
        {m.retry}
      </button>
    </span>
  );
}

function McpServerRow({
  server,
  status,
  badge,
  onToggle,
  onRemove,
  onRetry,
}: {
  server: McpServer;
  status: McpServerStatus | undefined;
  badge?: string;
  onToggle?: () => void;
  onRemove?: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations().settings;
  const target = mcpServerTarget(server);
  const errorText = server.enabled && status?.state === "error" ? status.error : undefined;
  return (
    <li className="px-3 py-2 rounded-[8px] border border-bg-300 bg-bg-100">
      <div className="flex items-center gap-3">
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            className={`w-9 h-5 shrink-0 rounded-full transition-colors relative ${server.enabled ? "bg-accent" : "bg-bg-300"}`}
            aria-label={server.enabled ? t.disable : t.enable}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-bg-0 transition-all ${server.enabled ? "left-4" : "left-0.5"}`} />
          </button>
        )}
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13px] font-medium text-text-100 truncate">{server.name}</span>
            {isStdioServer(server) && (
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase bg-bg-300 text-text-400">stdio</span>
            )}
            {badge && (
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase bg-bg-300 text-text-400">{badge}</span>
            )}
          </span>
          <span className="block text-[11px] text-text-400 font-mono truncate" data-tooltip={target}>{target}</span>
          <McpStatusLine server={server} status={status} onRetry={onRetry} />
        </span>
        {onRemove && (
          <button onClick={onRemove} className="p-1 rounded text-text-400 hover:text-red-400 shrink-0" aria-label={t.removeServer}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {errorText && (
        <p className="mt-1.5 text-[11px] text-red-400 font-mono whitespace-pre-wrap break-words line-clamp-4" data-tooltip={errorText}>
          {errorText}
        </p>
      )}
    </li>
  );
}

type SortMode = "default" | "popular" | "trending" | "new" | "alpha";

type ConnectorFilterKey = keyof Translations["settings"]["connectorFilters"];

const SORT_OPTIONS: { id: SortMode; key: ConnectorFilterKey }[] = [
  { id: "default", key: "sortDefault" },
  { id: "popular", key: "sortPopular" },
  { id: "trending", key: "sortTrending" },
  { id: "new", key: "sortNew" },
  { id: "alpha", key: "sortAlpha" },
];

const TYPE_LABELS: Record<NonNullable<ConnectorCatalogEntry["type"]>, ConnectorFilterKey> = {
  interactive: "typeInteractive",
  desktop: "typeDesktop",
  web: "typeWeb",
};

function sortConnectors(list: ConnectorCatalogEntry[], mode: SortMode): ConnectorCatalogEntry[] {
  const arr = list.map((entry, index) => ({ entry, index }));
  arr.sort((a, b) => {
    switch (mode) {
      case "popular":
        return (b.entry.popularity ?? 0) - (a.entry.popularity ?? 0) || a.index - b.index;
      case "trending":
        return (Number(b.entry.trending ?? false) - Number(a.entry.trending ?? false)) ||
          (b.entry.popularity ?? 0) - (a.entry.popularity ?? 0) || a.index - b.index;
      case "new":
        return (b.entry.addedAt ?? "").localeCompare(a.entry.addedAt ?? "") || a.index - b.index;
      case "alpha":
        return a.entry.name.localeCompare(b.entry.name);
      default:
        return a.index - b.index;
    }
  });
  return arr.map((x) => x.entry);
}

function FilterDropdown({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-[8px] text-sm font-medium border border-bg-300 text-text-200 hover:bg-bg-200"
      >
        {label}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div data-mod-menu className="absolute right-0 z-20 mt-1 min-w-[200px] max-h-[60vh] overflow-y-auto custom-scrollbar rounded-[8px] border border-bg-300 bg-bg-100 p-1.5 shadow-xl">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function FilterOption({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md text-left text-[13px] transition-colors ${
        active ? "text-text-100 bg-bg-200" : "text-text-300 hover:bg-bg-200 hover:text-text-200"
      }`}
    >
      <span className="truncate">{label}</span>
      {active && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
    </button>
  );
}

export function ConnectorDirectory() {
  const t = useTranslations().settings;
  const d = t.connectorDetail;
  const [servers, setServers] = useState<McpServer[]>(() => loadMcpServers());
  const [configServers] = useState<McpServer[]>(() => loadMergedMcpServers().filter((s) => s.id.startsWith("file:")));
  const statuses = useMcpStatuses();
  useEffect(() => {
    if (isTauri) void probeMcpServers([...servers, ...configServers], probeDeps);
  }, [servers, configServers]);
  const retryProbe = () => {
    if (isTauri) void probeMcpServers([...servers, ...configServers], probeDeps, true);
  };
  const [customPrefill, setCustomPrefill] = useState<CustomPrefill | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ConnectorCatalogEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsFor, setCredsFor] = useState<ConnectorCatalogEntry | null>(null);
  if (selected !== credsFor) {
    setCredsFor(selected);
    if (selected?.oauthManualClient) {
      setClientId(getOAuthClient(selected.name).clientId);
      setClientSecret("");
    }
  }
  // The client secret comes from the keychain, a moment after the form opens.
  useEffect(() => {
    if (!credsFor?.oauthManualClient) return;
    let alive = true;
    void getOAuthClientSecret(credsFor.name).then((secret) => {
      if (alive && secret) setClientSecret(secret);
    });
    return () => { alive = false; };
  }, [credsFor]);
  const [typeFilter, setTypeFilter] = useState<ConnectorCatalogEntry["type"] | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("default");

  const typeOptions = Array.from(
    new Set(CONNECTOR_CATALOG.map((c) => c.type).filter((t): t is NonNullable<typeof t> => !!t)),
  );
  const categoryOptions = Array.from(
    new Set(CONNECTOR_CATALOG.map((c) => c.category).filter((c): c is string => !!c)),
  ).sort((a, b) => a.localeCompare(b));
  const filterActive = typeFilter != null || categoryFilter != null;

  const persist = (next: McpServer[]) => { setServers(next); saveMcpServers(next); };
  const addServer = (server: McpServer) => { persist([...servers, server]); setCustomPrefill(undefined); };
  const stopIfRunning = (server: McpServer | undefined) => {
    if (isTauri && server) void stopMcpServer(server);
  };
  const toggle = (id: string) => {
    const target = servers.find((s) => s.id === id);
    if (target?.enabled) stopIfRunning(target);
    persist(servers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  };
  const remove = (id: string) => {
    const target = servers.find((s) => s.id === id);
    stopIfRunning(target);
    if (target?.oauth) void forgetConnectorTokens(id);
    persist(servers.filter((s) => s.id !== id));
  };
  const installedUrls = new Set(servers.map((s) => s.url));

  const addDirect = (entry: ConnectorCatalogEntry, headers?: Record<string, string>) =>
    persist([...servers, { id: crypto.randomUUID(), name: entry.name, url: entry.url, headers, enabled: true }]);

  const connect = async (entry: ConnectorCatalogEntry) => {
    if (installedUrls.has(entry.url)) return;
    if (entry.auth === "oauth") {
      let clientOpts: { clientId?: string; clientSecret?: string } = {};
      if (entry.oauthManualClient) {
        const builtinId = entry.oauthClientId?.trim();
        if (builtinId) {
          clientOpts = { clientId: builtinId, clientSecret: entry.oauthClientSecret?.trim() };
        } else {
          const cid = clientId.trim();
          if (!cid) {
            setSelected(entry);
            setOauthError(`${entry.name}: falta el Client ID de OAuth (configura el cliente integrado o pega uno aquí).`);
            return;
          }
          setOAuthClient(entry.name, { clientId: cid, clientSecret: clientSecret.trim() });
          clientOpts = { clientId: cid, clientSecret: clientSecret.trim() };
        }
      }
      setOauthError(null);
      setConnecting(entry.name);
      try {
        const tokens = await runMcpOAuth(entry.url, entry.name, {
          scopes: entry.oauthScopes,
          logo: entry.logo,
          color: entry.color,
          ...clientOpts,
        });
        // The tokens go to the keychain; the connector only says it signs in with OAuth.
        const id = crypto.randomUUID();
        await saveConnectorTokens(id, tokens);
        persist([...servers, { id, name: entry.name, url: entry.url, oauth: true, enabled: true }]);
        setSelected(null);
      } catch (e) {
        setOauthError(`${entry.name}: ${localizedError(e)}`);
      } finally {
        setConnecting(null);
      }
    } else if (entry.auth === "token") {
      setCustomPrefill({ name: entry.name, url: entry.url });
    } else {
      addDirect(entry);
      setSelected(null);
    }
  };

  const q = query.trim().toLowerCase();
  const results = sortConnectors(
    CONNECTOR_CATALOG.filter(
      (c) =>
        (!q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) &&
        (!typeFilter || c.type === typeFilter) &&
        (!categoryFilter || c.category === categoryFilter),
    ),
    sort,
  );
  const authLabel: Record<ConnectorCatalogEntry["auth"], string> = {
    none: t.noAuth,
    token: t.tokenRequired,
    oauth: t.oauthRequired,
  };
  const popularityRank = new Map<string, number>();
  [...CONNECTOR_CATALOG]
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .forEach((c, i) => popularityRank.set(c.url, i + 1));
  const newestDate = CONNECTOR_CATALOG.reduce(
    (m, c) => (c.addedAt && c.addedAt > m ? c.addedAt : m),
    "",
  );

  return (
    <div>
        {selected ? (
          <div className="overflow-y-auto custom-scrollbar">
            <button
              onClick={() => setSelected(null)}
              className="inline-flex items-center gap-1 text-[13px] text-text-400 hover:text-text-200 mb-4"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> {d.back}
            </button>

            <div className="flex items-start gap-4">
              <ConnectorIcon entry={selected} size={52} />
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl font-semibold text-text-100">{selected.name}</h2>
                <p className="text-sm text-text-400 mt-0.5">{selected.description}</p>
              </div>
              <button
                disabled={installedUrls.has(selected.url) || connecting === selected.name}
                onClick={() => connect(selected)}
                className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-[8px] text-sm font-medium bg-bg-0 border border-bg-300 text-text-100 hover:bg-bg-200 disabled:opacity-50"
              >
                {connecting === selected.name && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {installedUrls.has(selected.url)
                  ? d.added
                  : connecting === selected.name
                    ? d.connecting
                    : d.connect}
              </button>
            </div>

            {connecting === selected.name && (
              <p className="text-[12px] text-text-400 mt-3">
                {d.oauthBrowserHint}
              </p>
            )}
            {oauthError && oauthError.startsWith(selected.name) && (
              <p className="text-[12px] text-red-400 mt-3 break-words">{oauthError}</p>
            )}

            <p className="text-[13px] text-text-300 leading-relaxed mt-5">
              {selected.longDescription ?? selected.description}
            </p>

            {selected.oauthManualClient && !selected.oauthClientId?.trim() && (
              <div className="mt-5 rounded-[8px] border border-bg-300 bg-bg-200/40 p-4 space-y-3">
                <div>
                  <p className="text-[13px] font-semibold text-text-100">{d.oauthCredentials}</p>
                  <p className="text-[11.5px] text-text-400 mt-0.5">
                    {d.googleOAuthHelp1}
                    <span className="text-text-200"> “{d.googleOAuthDesktopType}”</span> {d.googleOAuthHelp2}{" "}
                    <a href="https://console.cloud.google.com/apis/credentials" onClick={handleExternalLinkClick} rel="noreferrer" className="text-accent hover:underline inline-flex items-center gap-0.5">
                      Google Cloud Console <ExternalLink className="w-3 h-3" />
                    </a>{" "}
                    {d.googleOAuthHelp3}
                  </p>
                </div>
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={d.clientIdPlaceholder}
                  className="w-full px-3 py-2 text-sm rounded-md bg-bg-100 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono"
                />
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={d.clientSecretPlaceholder}
                  className="w-full px-3 py-2 text-sm rounded-md bg-bg-100 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono"
                />
              </div>
            )}

            {selected.developer && (
              <div className="mt-5">
                <p className="text-[13px] text-text-200">
                  {d.developedBy}{" "}
                  {selected.developerUrl ? (
                    <a href={selected.developerUrl} onClick={handleExternalLinkClick} rel="noreferrer" className="text-accent hover:underline inline-flex items-center gap-0.5">
                      {selected.developer} <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <span className="text-text-100">{selected.developer}</span>
                  )}
                </p>
                <p className="text-[11.5px] text-text-500 mt-1 max-w-prose">
                  {d.developerTrustNote}
                </p>
              </div>
            )}

            <div className="h-px bg-bg-300 my-5" />

            <h4 className="text-sm font-semibold text-text-100 mb-3">{d.details}</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-text-500 mb-1">{d.authentication}</p>
                <p className="text-[13px] text-text-200">{authLabel[selected.auth]}</p>
              </div>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-text-500 mb-1">{d.connectorUrl}</p>
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] text-text-300 font-mono truncate">{selected.url}</span>
                  <button
                    onClick={() => { void navigator.clipboard.writeText(selected.url); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
                    className="p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-300 shrink-0"
                    aria-label={d.copyUrl}
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
              {selected.developerUrl && (
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-text-500 mb-1">{d.author}</p>
                  <a href={selected.developerUrl} onClick={handleExternalLinkClick} rel="noreferrer" className="text-[13px] text-accent hover:underline inline-flex items-center gap-0.5">
                    {selected.developer ?? selected.developerUrl} <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
              {selected.docsUrl && (
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-text-500 mb-1">{d.moreInfo}</p>
                  <a href={selected.docsUrl} onClick={handleExternalLinkClick} rel="noreferrer" className="text-[13px] text-accent hover:underline inline-flex items-center gap-0.5">
                    {d.documentation} <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col min-h-0">
            <div className="mb-4 space-y-3">
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t.searchConnectors}
                  className="w-full pl-10 pr-3 py-3 text-sm rounded-[8px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent"
                />
              </div>
              <div className="flex items-center justify-end gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setCustomPrefill(null)}
                  className="mr-auto inline-flex items-center gap-1.5 px-3 py-2.5 rounded-[8px] text-sm font-medium border border-bg-300 text-text-200 hover:bg-bg-200"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t.addConnector}
                </button>
                <div className="flex items-center gap-2">
              <FilterDropdown label={t.connectorFilters.filterBy}>
                {(close) => (
                  <>
                    <p className="px-2.5 pt-1 pb-1 text-[11px] uppercase tracking-wide text-text-500">{t.connectorFilters.type}</p>
                    {typeOptions.map((tp) => (
                      <FilterOption
                        key={tp}
                        active={typeFilter === tp}
                        label={t.connectorFilters[TYPE_LABELS[tp]]}
                        onClick={() => { setTypeFilter(typeFilter === tp ? null : tp); close(); }}
                      />
                    ))}
                    <div className="h-px bg-bg-300 my-1.5" />
                    <p className="px-2.5 pt-1 pb-1 text-[11px] uppercase tracking-wide text-text-500">{t.connectorFilters.category}</p>
                    {categoryOptions.map((cat) => (
                      <FilterOption
                        key={cat}
                        active={categoryFilter === cat}
                        label={cat}
                        onClick={() => { setCategoryFilter(categoryFilter === cat ? null : cat); close(); }}
                      />
                    ))}
                    {filterActive && (
                      <>
                        <div className="h-px bg-bg-300 my-1.5" />
                        <FilterOption
                          active={false}
                          label={t.connectorFilters.clearFilters}
                          onClick={() => { setTypeFilter(null); setCategoryFilter(null); close(); }}
                        />
                      </>
                    )}
                  </>
                )}
              </FilterDropdown>
              <FilterDropdown label={t.connectorFilters.sortBy}>
                {(close) =>
                  SORT_OPTIONS.map((opt) => (
                    <FilterOption
                      key={opt.id}
                      active={sort === opt.id}
                      label={t.connectorFilters[opt.key]}
                      onClick={() => { setSort(opt.id); close(); }}
                    />
                  ))
                }
              </FilterDropdown>
                </div>
              </div>
              <p className="text-[12px] text-text-500">{d.availableForTeam}</p>
            </div>

            {connecting && (
              <div className="mb-3 flex items-center gap-2 text-[12px] text-text-300">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {d.connectingHint.replace("{name}", connecting)}
              </div>
            )}
            {oauthError && <p className="text-[12px] text-red-400 mb-3 break-words">{oauthError}</p>}

            {servers.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] uppercase tracking-wide text-text-500 mb-2">{d.connected}</p>
                <ul className="space-y-2">
                  {servers.map((s) => (
                    <McpServerRow
                      key={s.id}
                      server={s}
                      status={statuses[s.id]}
                      onToggle={() => toggle(s.id)}
                      onRemove={() => remove(s.id)}
                      onRetry={retryProbe}
                    />
                  ))}
                </ul>
              </div>
            )}

            {configServers.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] uppercase tracking-wide text-text-500 mb-2">{d.mcpStatus.fromConfig}</p>
                <ul className="space-y-2">
                  {configServers.map((s) => (
                    <McpServerRow key={s.id} server={s} status={statuses[s.id]} badge={s.source} onRetry={retryProbe} />
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {results.map((c) => {
                const installed = installedUrls.has(c.url);
                const rank = popularityRank.get(c.url) ?? 0;
                const popLabel = rank === 1 ? d.mostPopular : rank > 1 ? d.popularRank.replace("{rank}", String(rank)) : authLabel[c.auth];
                const isNew = !!c.addedAt && c.addedAt === newestDate;
                return (
                  <button
                    key={c.url}
                    type="button"
                    onClick={() => setSelected(c)}
                    className="text-left rounded-[8px] border border-bg-300 bg-bg-100 hover:bg-bg-200 hover:border-bg-300 transition-colors p-4 flex flex-col gap-3"
                  >
                    <div className="flex items-start gap-3">
                      <ConnectorIcon entry={c} />
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="text-[14px] font-semibold text-text-100 truncate">{c.name}</span>
                          {isNew && <span className="shrink-0 text-[11px] font-medium text-orange-400">{d.badgeNew}</span>}
                          {c.trending && (
                            <span className="shrink-0 inline-flex items-center gap-0.5 text-[11px] text-text-400">
                              <TrendingUp className="w-3 h-3" /> {d.badgeTrending}
                            </span>
                          )}
                        </span>
                        <span className="block text-[12px] text-text-400 mt-0.5">{popLabel}</span>
                      </span>
                      <span
                        className="shrink-0 p-1 rounded-md text-text-400"
                        aria-label={installed ? t.alreadyAdded : t.add}
                        onClick={(e) => { e.stopPropagation(); if (!installed) connect(c); }}
                      >
                        {installed ? <Check className="w-4 h-4 text-green-400" /> : <Plus className="w-4 h-4 hover:text-text-100" />}
                      </span>
                    </div>
                    <p className="text-[12px] text-text-400 leading-snug line-clamp-2">{c.description}</p>
                  </button>
                );
              })}
              {results.length === 0 && <p className="text-xs text-text-400 col-span-full">{t.noResults}</p>}
            </div>
          </div>
        )}

      {customPrefill !== undefined && (
        <CustomConnectorModal
          prefill={customPrefill}
          existingNames={servers.map((s) => s.name)}
          onAdd={addServer}
          onClose={() => setCustomPrefill(undefined)}
        />
      )}
    </div>
  );
}

export function McpServersSection() {
  return <ConnectorDirectory />;
}
