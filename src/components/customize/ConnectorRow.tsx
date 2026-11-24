import type { ReactNode } from "react";
import { BadgeCheck, Check, Loader2, Plus, RefreshCw } from "lucide-react";
import type { ConnectorCatalogEntry } from "@/lib/mcp";
import { useTranslations } from "@/lib/i18n";
import { ConnectorLogo } from "./logos";
import { isVerified } from "./connectorData";
import { SquareAction } from "./ui";
import type { Connectors } from "./useConnectors";

/** Two columns of rows separated by thin lines, as in the connector directory. */
export function RowGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10">{children}</div>;
}

/** The "+" of a connector, or what state it is in once added. */
export function ConnectorAction({ entry, connectors }: { entry: ConnectorCatalogEntry; connectors: Connectors }) {
  const t = useTranslations().customizePage;
  const server = connectors.serverFor(entry);
  const status = server ? connectors.statuses[server.id] : undefined;
  if (connectors.connecting === entry.name || (server?.enabled && status?.state === "connecting")) {
    return (
      <SquareAction label={t.connecting} disabled>
        <Loader2 className="w-4 h-4 animate-spin" />
      </SquareAction>
    );
  }
  if (server?.enabled && status?.state === "error") {
    return (
      <SquareAction label={t.reconnect} onClick={connectors.retry}>
        <RefreshCw className="w-4 h-4" />
      </SquareAction>
    );
  }
  if (server?.enabled) {
    return (
      <SquareAction label={t.connected} tone="success" disabled>
        <Check className="w-4 h-4" />
      </SquareAction>
    );
  }
  return (
    <SquareAction label={server ? t.turnOn : t.connect} onClick={() => void connectors.connect(entry, undefined, t.missingClientId)}>
      <Plus className="w-4 h-4" />
    </SquareAction>
  );
}

function NameLine({ entry }: { entry: ConnectorCatalogEntry }) {
  const t = useTranslations().customizePage;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="text-[14px] font-medium text-text-100 truncate">{entry.name}</span>
      {isVerified(entry) && (
        <BadgeCheck className="w-4 h-4 shrink-0 text-text-400" aria-label={t.verified} strokeWidth={1.75} />
      )}
    </span>
  );
}

/** A connector in the page's directory: logo, name, what it does, who makes it, and "+". */
export function ConnectorRow({
  entry,
  connectors,
  onOpen,
}: {
  entry: ConnectorCatalogEntry;
  connectors: Connectors;
  onOpen: () => void;
}) {
  const t = useTranslations().customizePage;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className="group flex items-start gap-4 py-4 border-b border-bg-300 cursor-pointer outline-none focus-visible:bg-bg-200/50"
    >
      <ConnectorLogo entry={entry} size={48} />
      <span className="flex-1 min-w-0">
        <NameLine entry={entry} />
        <span className="block text-[13px] text-text-300 leading-snug mt-0.5 line-clamp-2">{entry.description}</span>
        {entry.developer && (
          <span className="block text-[13px] text-text-400 mt-0.5">{t.byDeveloper.replace("{name}", entry.developer)}</span>
        )}
      </span>
      <ConnectorAction entry={entry} connectors={connectors} />
    </div>
  );
}

/** A connector as a filled card, in the directory dialog. */
export function ConnectorCard({
  entry,
  connectors,
  onOpen,
}: {
  entry: ConnectorCatalogEntry;
  connectors: Connectors;
  onOpen: () => void;
}) {
  const t = useTranslations().customizePage;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className="flex items-start gap-3.5 p-3.5 rounded-[8px] bg-bg-200/60 hover:bg-bg-200 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <ConnectorLogo entry={entry} size={48} />
      <span className="flex-1 min-w-0">
        <NameLine entry={entry} />
        <span className="block text-[13px] text-text-300 leading-snug mt-0.5 line-clamp-2">{entry.description}</span>
        <span className="block text-[13px] text-text-400 mt-0.5 truncate">
          {t.connectorKind}
          {entry.developer && ` · ${t.byDeveloper.replace("{name}", entry.developer)}`}
        </span>
      </span>
      <ConnectorAction entry={entry} connectors={connectors} />
    </div>
  );
}
