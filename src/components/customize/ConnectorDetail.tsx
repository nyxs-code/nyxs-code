import { useState } from "react";
import { ArrowLeft, ArrowUpRight, BadgeCheck, Check, ChevronDown, Copy, Info, Loader2, MoreHorizontal, Power, Trash2 } from "lucide-react";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { cachedMcpTools, type ConnectorCatalogEntry } from "@/lib/mcp";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ConnectorLogo } from "./logos";
import { isVerified, relatedConnectors } from "./connectorData";
import { ConnectorToolsDialog } from "./ConnectorToolsDialog";
import { OAuthClientDialog } from "./OAuthClientDialog";
import { Dropdown, MenuItem } from "./ui";
import type { Connectors, ManualClient } from "./useConnectors";

function monthYear(iso: string | undefined, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { month: "long", year: "numeric" });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A blue link with an arrow, opened in the system browser (the "More information" list). */
function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      onClick={handleExternalLinkClick}
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-[14px] text-[color:var(--link)] underline underline-offset-2 hover:opacity-80"
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

/** A label and its value in the connector's card. */
function CardRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-4 py-1.5">
      <dt className="text-[13px] text-text-400 pt-px">{label}</dt>
      <dd className="min-w-0 text-[14px] text-text-100">{children}</dd>
    </div>
  );
}

/**
 * One connector's page, laid out like Claude's: who makes it and what it does on top, its
 * connector as a card that opens to its address, tools and sign-in, the facts on the side,
 * and related connectors below.
 */
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
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [askClient, setAskClient] = useState(false);
  const needsClient = !!entry.oauthManualClient && !entry.oauthClientId?.trim();

  // Once connected, the server's own list; before, the one its makers publish.
  const liveTools = server && status?.state === "connected" ? cachedMcpTools([server], false).map((x) => x.name) : [];
  const tools = liveTools.length > 0 ? liveTools : (entry.tools ?? []);
  const error = connectors.error?.startsWith(`${entry.name}:`) ? connectors.error : null;
  const failed = !!server?.enabled && status?.state === "error";
  // As in Claude, nothing says "Connecting…": Connect stays Connect while the sign-in is open in
  // the browser (pressing it again starts over), and shows Connected once the connector is in.
  const linked = !!server?.enabled && !failed;
  // A spinner for the few seconds the sign-in takes to open in the browser, as in Claude.
  const opening = connectors.opening === entry.name;
  const signIn: Record<ConnectorCatalogEntry["auth"], string> = {
    oauth: t.signInRequired,
    token: t.signInToken,
    none: t.signInNone,
  };
  const authorization: Record<ConnectorCatalogEntry["auth"], string> = {
    oauth: t.authSignIn,
    token: t.authToken,
    none: t.authNone,
  };

  const connect = (client?: ManualClient) => {
    setAskClient(false);
    void connectors.connect(entry, client, t.missingClientId);
  };
  /** Claude's "Connect": signs in at once, or first asks for the OAuth client a service needs. */
  const onConnect = () => {
    if (failed) connectors.retry();
    else if (!server && needsClient) setAskClient(true);
    else connect();
  };

  const copyUrl = () => {
    void navigator.clipboard.writeText(entry.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const state = failed ? t.connectionFailed : linked ? t.connected : server ? t.turnedOff : t.notConnected;
  const action = failed ? t.reconnect : server && !server.enabled ? t.turnOn : t.connect;
  const published = monthYear(entry.addedAt, getLanguage());
  const links = [
    entry.developerUrl && { href: entry.developerUrl, label: t.developerWebsite },
    entry.docsUrl && { href: entry.docsUrl, label: t.documentation },
    entry.supportUrl && { href: entry.supportUrl, label: t.support },
    entry.privacyUrl && { href: entry.privacyUrl, label: t.privacyPolicy },
  ].filter((l): l is { href: string; label: string } => !!l);

  return (
    <div className="max-w-[960px] mx-auto">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-[14px] text-text-200 hover:text-text-100 mb-5"
      >
        <ArrowLeft className="w-4 h-4" />
        {backLabel}
      </button>

      <div className="flex items-center gap-4 pb-7 border-b border-bg-300">
        <ConnectorLogo entry={entry} size={44} />
        <div className="flex-1 min-w-0">
          <h1 className="text-[22px] leading-tight text-text-100">{entry.name}</h1>
          <p className="text-[14px] text-text-400 mt-0.5 truncate">
            {entry.developer && (
              <>
                {t.byDeveloper.replace("{name}", entry.developer)}
                <span className="mx-1.5">·</span>
              </>
            )}
            {entry.description}
          </p>
        </div>
        <Dropdown
          trigger={(open, toggle) => (
            <button
              type="button"
              onClick={toggle}
              aria-label={t.moreOptions}
              aria-expanded={open}
              className={cn(
                "h-8 w-8 inline-flex items-center justify-center rounded-[6px] text-text-300 hover:text-text-100 hover:bg-bg-200 transition-colors",
                open && "bg-bg-200 text-text-100",
              )}
            >
              <MoreHorizontal className="w-4 h-4" />
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
        {linked ? (
          <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-200">
            <Check className="w-4 h-4 text-green-500" />
            {t.connected}
          </span>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            disabled={opening}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] bg-text-100 text-bg-0 text-[14px] font-medium transition-opacity hover:opacity-90 disabled:opacity-80"
          >
            {opening && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {action}
          </button>
        )}
      </div>

      {error && <p className="text-[13px] text-red-400 mt-4 break-words">{error}</p>}
      {failed && status?.state === "error" && <p className="text-[13px] text-amber-500 mt-4 break-words">{status.error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_260px] gap-x-10 gap-y-8 pt-7">
        <div className="min-w-0">
          <p className="text-[14px] text-text-100 leading-relaxed">{entry.longDescription ?? entry.description}</p>

          <h2 className="text-[15px] font-medium text-text-100 mt-8 mb-3">{t.connectors}</h2>
          <div className="rounded-[8px] bg-bg-200/60">
            <div className="flex items-center gap-2.5 pl-4 pr-2 py-2">
              <ConnectorLogo entry={entry} size={20} />
              <span className="flex-1 min-w-0 truncate text-[14px] font-medium text-text-100">{entry.name}</span>
              <span className={cn("text-[13px]", failed ? "text-amber-500" : "text-text-400")}>{state}</span>
              {!linked && (
                <button
                  type="button"
                  onClick={onConnect}
                  disabled={opening}
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[6px] bg-bg-300/70 text-[14px] text-text-100 hover:bg-bg-300 transition-colors disabled:hover:bg-bg-300/70"
                >
                  {opening && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {action}
                </button>
              )}
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-label={expanded ? t.hideDetails : t.showDetails}
                aria-expanded={expanded}
                className="h-7 w-7 inline-flex items-center justify-center rounded-[6px] text-text-400 hover:text-text-100 hover:bg-bg-300/60 transition-colors"
              >
                <ChevronDown className={cn("w-4 h-4 transition-transform", expanded && "rotate-180")} />
              </button>
            </div>
            {expanded && (
              <dl className="pl-12 pr-4 pb-3">
                <CardRow label={t.connectorUrl}>
                  <span className="inline-flex items-start gap-1.5 max-w-full">
                    <span className="break-all">{entry.url}</span>
                    <button
                      type="button"
                      onClick={copyUrl}
                      aria-label={t.copyUrl}
                      className="mt-0.5 shrink-0 text-text-400 hover:text-text-100 transition-colors"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </span>
                </CardRow>
                <CardRow label={t.tools}>
                  {tools.length > 0 ? (
                    <>
                      <p className="line-clamp-3 break-words">{tools.join(", ")}</p>
                      <button
                        type="button"
                        onClick={() => setToolsOpen(true)}
                        className="mt-1.5 h-6 px-2 rounded-[6px] bg-bg-300/70 text-[13px] text-text-100 hover:bg-bg-300 transition-colors"
                      >
                        {t.showAllCount.replace("{count}", String(tools.length))}
                      </button>
                    </>
                  ) : (
                    <span className="text-[13px] text-text-400">{server ? t.toolsLoading : t.toolsAfterConnect}</span>
                  )}
                </CardRow>
                <CardRow label={t.signIn}>{signIn[entry.auth]}</CardRow>
              </dl>
            )}
          </div>
        </div>

        <aside className="space-y-5">
          {entry.developer && (
            <Fact label={t.developer}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[14px] text-text-100">{entry.developer}</span>
                {isVerified(entry) && (
                  <>
                    <span className="inline-flex items-center gap-1 h-6 px-2 rounded-[6px] bg-blue-500/10 text-[12px] font-medium text-blue-500">
                      <BadgeCheck className="w-3.5 h-3.5" />
                      {t.verified}
                    </span>
                    <span aria-label={t.verifiedHint} data-tooltip={t.verifiedHint} className="text-text-400 hover:text-text-100">
                      <Info className="w-4 h-4" />
                    </span>
                  </>
                )}
              </div>
            </Fact>
          )}
          <Fact label={t.securityAccess}>
            <p className="text-[14px] text-text-100 break-words">{t.canSendDataTo.replace("{host}", hostOf(entry.url))}</p>
          </Fact>
          <Fact label={t.authorization}>
            <p className="text-[14px] text-text-100">{authorization[entry.auth]}</p>
          </Fact>
          {entry.category && (
            <Fact label={t.category}>
              <span className="inline-flex h-7 items-center px-2.5 rounded-[6px] bg-bg-200 text-[13px] text-text-100">
                {entry.category}
              </span>
            </Fact>
          )}
          {published && (
            <Fact label={t.published}>
              <p className="text-[14px] text-text-100">{published}</p>
            </Fact>
          )}
          {links.length > 0 && (
            <Fact label={t.moreInfo}>
              <div className="flex flex-col items-start gap-1.5">
                {links.map((l) => (
                  <ExternalLink key={l.label} href={l.href}>{l.label}</ExternalLink>
                ))}
              </div>
            </Fact>
          )}
        </aside>
      </div>

      <div className="border-t border-bg-300 mt-10 pt-8">
        <h2 className="text-[15px] font-medium text-text-100 mb-2">{t.relatedConnectors}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10">
          {relatedConnectors(entry).map((c) => (
            <button
              key={c.url}
              type="button"
              onClick={() => onOpen(c)}
              className="flex items-start gap-3 py-3.5 border-b border-bg-300 text-left outline-none focus-visible:bg-bg-200/50"
            >
              <ConnectorLogo entry={c} size={28} />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[14px] font-medium text-text-100 truncate">{c.name}</span>
                  {isVerified(c) && <BadgeCheck className="w-4 h-4 shrink-0 text-text-400" aria-label={t.verified} strokeWidth={1.75} />}
                </span>
                <span className="block text-[13px] text-text-300 leading-snug mt-0.5 line-clamp-2">{c.description}</span>
                <span className="block text-[13px] text-text-400 mt-0.5 truncate">
                  {t.connectorKind}
                  {c.developer && ` · ${t.byDeveloper.replace("{name}", c.developer)}`}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <ConnectorToolsDialog name={entry.name} tools={tools} open={toolsOpen} onClose={() => setToolsOpen(false)} />
      {needsClient && <OAuthClientDialog entry={entry} open={askClient} onClose={() => setAskClient(false)} onConnect={connect} />}
    </div>
  );
}
