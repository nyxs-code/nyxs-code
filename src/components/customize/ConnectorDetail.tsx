import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, BadgeCheck, Check, ChevronDown, Copy, Loader2, Power, Trash2 } from "lucide-react";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { cachedMcpTools, getOAuthClient, getOAuthClientSecret, type ConnectorCatalogEntry } from "@/lib/mcp";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ConnectorLogo } from "./logos";
import { isVerified, relatedConnectors } from "./connectorData";
import { ConnectorRow, RowGrid } from "./ConnectorRow";
import { Dropdown, MenuItem } from "./ui";
import type { Connectors } from "./useConnectors";

function monthYear(iso: string | undefined, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { month: "long", year: "numeric" });
}

function ExternalLinkText({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      onClick={handleExternalLinkClick}
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-[14px] text-text-100 underline underline-offset-2 decoration-text-400 hover:decoration-text-100"
    >
      {children}
      <ArrowUpRight className="w-3.5 h-3.5" />
    </a>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[13px] text-text-400 mb-1">{label}</p>
      {children}
    </div>
  );
}

/** One connector's page: what it does, its tools, who makes it and how it signs in. */
export function ConnectorDetail({
  entry,
  connectors,
  onBack,
  onOpen,
  backLabel,
}: {
  entry: ConnectorCatalogEntry;
  connectors: Connectors;
  onBack: () => void;
  onOpen: (entry: ConnectorCatalogEntry) => void;
  backLabel: string;
}) {
  const tr = useTranslations();
  const t = tr.customizePage;
  const server = connectors.serverFor(entry);
  const status = server ? connectors.statuses[server.id] : undefined;
  const busy = connectors.connecting === entry.name;
  const [copied, setCopied] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);
  const needsClient = !!entry.oauthManualClient && !entry.oauthClientId?.trim();
  const [clientId, setClientId] = useState(() => (needsClient ? getOAuthClient(entry.name).clientId : ""));
  const [clientSecret, setClientSecret] = useState("");

  // The client secret comes from the keychain, a moment after the page opens.
  useEffect(() => {
    if (!needsClient) return;
    let alive = true;
    void getOAuthClientSecret(entry.name).then((secret) => {
      if (alive && secret) setClientSecret(secret);
    });
    return () => {
      alive = false;
    };
  }, [entry.name, needsClient]);

  const tools = server && status?.state === "connected" ? cachedMcpTools([server], false).map((x) => x.name) : [];
  const visibleTools = showAllTools ? tools : tools.slice(0, 18);
  const error = connectors.error?.startsWith(`${entry.name}:`) ? connectors.error : null;
  const authLabel: Record<ConnectorCatalogEntry["auth"], string> = {
    oauth: t.signInRequired,
    token: t.signInToken,
    none: t.signInNone,
  };

  const connect = () =>
    void connectors.connect(entry, needsClient ? { clientId, clientSecret } : undefined, t.missingClientId);

  const copyUrl = () => {
    void navigator.clipboard.writeText(entry.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const primaryLabel = busy
    ? t.connecting
    : server
      ? server.enabled
        ? t.connected
        : t.turnOn
      : t.connectWithNyxs;

  return (
    <div className="max-w-[960px] mx-auto">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-[14px] text-text-200 hover:text-text-100 mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        {backLabel}
      </button>

      <div className="flex items-start gap-4 pb-8 border-b border-bg-300">
        <ConnectorLogo entry={entry} size={48} />
        <div className="flex-1 min-w-0">
          <h1 className="text-[24px] leading-tight text-text-100">{entry.name}</h1>
          <p className="text-[14px] text-text-400 mt-1">{entry.description}</p>
        </div>
        {/* A split button in the colors of the page's "Add" button: the tint goes on each half,
            so hovering one doesn't light up the other. */}
        <div className="self-center flex items-center shrink-0 h-9 rounded-[8px] bg-text-100 text-bg-0 shadow-sm">
          <button
            type="button"
            disabled={busy || (!!server && server.enabled)}
            onClick={connect}
            className="inline-flex items-center gap-2 h-full pl-4 pr-3.5 rounded-l-[8px] text-[14px] font-medium transition-colors hover:bg-bg-0/10 disabled:hover:bg-transparent disabled:cursor-default"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {server?.enabled && !busy && <Check className="w-4 h-4" />}
            {primaryLabel}
          </button>
          <span aria-hidden className="w-px h-4 bg-current opacity-25" />
          <Dropdown
            trigger={(open, toggle) => (
              <button
                type="button"
                onClick={toggle}
                aria-label={t.moreOptions}
                aria-expanded={open}
                className={cn(
                  "h-9 px-2.5 rounded-r-[8px] transition-colors hover:bg-bg-0/10",
                  open && "bg-bg-0/10",
                )}
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<Copy className="w-4 h-4" />} label={t.copyUrl} onClick={() => { copyUrl(); close(); }} />
                {server && (
                  <MenuItem
                    icon={<Power className="w-4 h-4" />}
                    label={server.enabled ? t.turnOff : t.turnOn}
                    onClick={() => { connectors.toggle(server.id); close(); }}
                  />
                )}
                {server && (
                  <MenuItem
                    danger
                    icon={<Trash2 className="w-4 h-4" />}
                    label={t.removeConnector}
                    onClick={() => { connectors.remove(server.id); close(); }}
                  />
                )}
              </>
            )}
          </Dropdown>
        </div>
      </div>

      {busy && <p className="text-[13px] text-text-400 mt-4">{t.oauthBrowserHint}</p>}
      {error && <p className="text-[13px] text-red-400 mt-4 break-words">{error}</p>}
      {server && status?.state === "error" && (
        <p className="text-[13px] text-amber-500 mt-4 break-words">{status.error}</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_260px] gap-x-12 gap-y-8 pt-8">
        <div className="min-w-0">
          <p className="text-[14px] text-text-200 leading-relaxed">{entry.longDescription ?? entry.description}</p>

          {needsClient && !server && (
            <div className="mt-6 rounded-[8px] border border-bg-300 p-4 space-y-3">
              <div>
                <p className="text-[14px] font-medium text-text-100">{t.oauthCredentials}</p>
                <p className="text-[12.5px] text-text-400 mt-1">
                  {t.oauthCredentialsHint}{" "}
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    onClick={handleExternalLinkClick}
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    Google Cloud Console
                  </a>
                </p>
              </div>
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Client ID"
                className="w-full h-9 px-3 text-[13px] rounded-[6px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono"
              />
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Client secret"
                className="w-full h-9 px-3 text-[13px] rounded-[6px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono"
              />
            </div>
          )}

          <h3 className="text-[14px] text-text-200 mt-8 mb-3">{t.tools}</h3>
          {tools.length > 0 ? (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2.5">
                {visibleTools.map((name) => (
                  <span key={name} className="justify-self-start max-w-full truncate px-3 py-1 rounded-[6px] bg-bg-200 text-[13px] text-text-200">
                    {name}
                  </span>
                ))}
              </div>
              {tools.length > visibleTools.length && (
                <button
                  type="button"
                  onClick={() => setShowAllTools(true)}
                  className="mt-5 text-[14px] text-text-100 hover:underline"
                >
                  {t.showAll}
                </button>
              )}
            </>
          ) : (
            <p className="text-[13px] text-text-400">{server ? t.toolsLoading : t.toolsAfterConnect}</p>
          )}
        </div>

        <aside className="space-y-6">
          {entry.developer && (
            <Fact label={t.developer}>
              <div className="flex items-center gap-2 flex-wrap">
                {entry.developerUrl ? (
                  <ExternalLinkText href={entry.developerUrl}>{entry.developer}</ExternalLinkText>
                ) : (
                  <span className="text-[14px] text-text-100">{entry.developer}</span>
                )}
                {isVerified(entry) && (
                  <span className="inline-flex items-center gap-1 h-6 px-2 rounded-[6px] bg-blue-500/10 text-[12px] font-medium text-blue-500">
                    <BadgeCheck className="w-3.5 h-3.5" />
                    {t.verified}
                  </span>
                )}
              </div>
            </Fact>
          )}
          {entry.category && (
            <Fact label={t.category}>
              <span className="inline-flex h-7 items-center px-2.5 rounded-[6px] bg-bg-200 text-[13px] text-text-200">
                {entry.category}
              </span>
            </Fact>
          )}
          <Fact label={t.signIn}>
            <p className="text-[14px] text-text-100">{authLabel[entry.auth]}</p>
          </Fact>
          <Fact label={t.connectorUrl}>
            <button
              type="button"
              onClick={copyUrl}
              className="group text-left font-mono text-[12.5px] text-text-100 break-all leading-relaxed"
            >
              {entry.url}
              <span className="inline-flex align-middle ml-1.5 text-text-400 group-hover:text-text-100">
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              </span>
            </button>
          </Fact>
          {monthYear(entry.addedAt, getLanguage()) && (
            <Fact label={t.addedOn}>
              <p className="text-[14px] text-text-100 first-letter:uppercase">
                {monthYear(entry.addedAt, getLanguage())}
              </p>
            </Fact>
          )}
          {(entry.docsUrl || entry.developerUrl) && (
            <Fact label={t.moreInfo}>
              <div className="flex flex-col items-start gap-1">
                {entry.docsUrl && <ExternalLinkText href={entry.docsUrl}>{t.documentation}</ExternalLinkText>}
                {entry.developerUrl && <ExternalLinkText href={entry.developerUrl}>{t.website}</ExternalLinkText>}
              </div>
            </Fact>
          )}
        </aside>
      </div>

      <div className="border-t border-bg-300 mt-10 pt-10">
        <h2 className="text-[22px] text-text-100 mb-4">{t.relatedConnectors}</h2>
        <RowGrid>
          {relatedConnectors(entry).map((c) => (
            <ConnectorRow key={c.url} entry={c} connectors={connectors} onOpen={() => onOpen(c)} />
          ))}
        </RowGrid>
      </div>
    </div>
  );
}
