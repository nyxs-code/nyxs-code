import { useEffect, useState } from "react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getOAuthClient, getOAuthClientSecret, type ConnectorCatalogEntry } from "@/lib/mcp";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { useTranslations } from "@/lib/i18n";
import type { ManualClient } from "./useConnectors";

/** What to register as the OAuth app's callback: the sign-in comes back here, on a free port. */
const LOOPBACK_CALLBACK = "http://127.0.0.1/callback";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const FIELD =
  "w-full h-9 px-3 text-[13px] rounded-[6px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono";

/**
 * Asked on "Connect" for a connector whose service gives no client to sign in with (Google's):
 * the user's own OAuth client, kept for next time. Claude ships its own client, so its page has
 * no such fields; here they wait behind the button until they're needed.
 */
export function OAuthClientDialog({
  entry,
  open,
  onClose,
  onConnect,
}: {
  entry: ConnectorCatalogEntry;
  open: boolean;
  onClose: () => void;
  onConnect: (client: ManualClient) => void;
}) {
  const t = useTranslations().customizePage;
  const [clientId, setClientId] = useState(() => getOAuthClient(entry.name).clientId);
  const [clientSecret, setClientSecret] = useState("");

  // The secret comes from the keychain, a moment after the dialog opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void getOAuthClientSecret(entry.name).then((secret) => {
      if (alive && secret) setClientSecret(secret);
    });
    return () => {
      alive = false;
    };
  }, [entry.name, open]);

  const ready = clientId.trim().length > 0;
  return (
    <Dialog open={open} onClose={onClose} className="max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{t.oauthCredentials}</DialogTitle>
      </DialogHeader>
      <form
        className="px-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onConnect({ clientId, clientSecret });
        }}
      >
        {entry.oauthClientConsole ? (
          // A service like GitHub: an OAuth app of the user's, called back on the loopback (any
          // port: the sign-in picks a free one each time).
          <p className="text-[13px] text-text-300 leading-relaxed">
            {t.oauthAppHint.split(/(\{site\}|\{callback\})/).map((part, i) =>
              part === "{site}" ? (
                <a
                  key={i}
                  href={entry.oauthClientConsole}
                  onClick={handleExternalLinkClick}
                  rel="noreferrer"
                  className="underline underline-offset-2 text-text-100"
                >
                  {hostOf(entry.oauthClientConsole!)}
                </a>
              ) : part === "{callback}" ? (
                <code key={i} className="font-mono text-[12px] text-text-100">{LOOPBACK_CALLBACK}</code>
              ) : (
                part
              ),
            )}
          </p>
        ) : (
          <p className="text-[13px] text-text-300 leading-relaxed">
            {t.oauthCredentialsHint}{" "}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              onClick={handleExternalLinkClick}
              rel="noreferrer"
              className="underline underline-offset-2 text-text-100"
            >
              Google Cloud Console
            </a>
          </p>
        )}
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" aria-label="Client ID" className={FIELD} />
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="Client secret"
          aria-label="Client secret"
          className={FIELD}
        />
        <button type="submit" hidden />
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        <Button variant="primary" disabled={!ready} onClick={() => onConnect({ clientId, clientSecret })}>
          {t.connect}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
