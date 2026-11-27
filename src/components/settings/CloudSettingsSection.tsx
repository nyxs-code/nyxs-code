import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { AUTH_CHANGED_EVENT, getAuthSnapshot } from "@/lib/auth";
import { PROVIDERS, type ProviderId } from "@/lib/models";
import type { Settings } from "@/lib/settings";
import { deleteCloudSecret, listCloudSecrets, putCloudSecrets } from "@/lib/cloud/cloudApi";
import { CLI_CLOUD_KEYS, GITHUB_CLOUD_KEY, cloudSupport, providerCloudKey } from "@/lib/cloud/cloudCredentials";
import { SectionTitle, SettingsToggle, DisabledToggle } from "./settingsControls";
import { fieldInputClass } from "./fieldClasses";

const buttonClass =
  "inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] text-xs font-medium border border-bg-300 text-text-100 hover:bg-bg-200 disabled:opacity-60 transition-colors shrink-0";

function Row({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-4 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-100">{title}</p>
        <p className="text-[12px] text-text-400 mt-0.5">{desc}</p>
      </div>
      {children}
    </li>
  );
}

/** A credential the user pastes (Claude Code's token, the GitHub token): an input until it's
 *  stored, then a tag and "Remove". The cloud never gives a value back, only whether it has one. */
function TokenRow({ title, desc, stored, onSave, onRemove }: {
  title: string;
  desc: string;
  stored: boolean;
  onSave: (value: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const c = useTranslations().cloud;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setDraft("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="py-4">
      <p className="text-sm font-medium text-text-100">{title}</p>
      <p className="text-[12px] text-text-400 mt-0.5">{desc}</p>
      <div className="mt-2.5 flex items-center gap-2">
        {stored ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-text-300">
              <Check className="w-3.5 h-3.5 text-green-500" />
              {c.storedTag}
            </span>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(onRemove)}>
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {c.remove}
            </button>
          </>
        ) : (
          <>
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={c.tokenPlaceholder}
              aria-label={`${title}: ${c.tokenPlaceholder}`}
              autoComplete="off"
              spellCheck={false}
              className={`${fieldInputClass} h-8 py-0 rounded-[6px] max-w-[360px]`}
            />
            <button type="button" className={buttonClass} disabled={busy || !draft.trim()} onClick={() => void run(() => onSave(draft.trim()))}>
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {c.save}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Settings › Nube: which of the user's credentials the Nyxs cloud may use for their cloud
 * threads. Provider keys come from this computer's keychain, one switch each; the Claude Code
 * token and the GitHub token are pasted. What the cloud has is read back from it (names only).
 */
export function CloudSettingsSection({ settings }: { settings: Settings }) {
  const t = useTranslations();
  const c = t.cloud;
  const [signedIn, setSignedIn] = useState(() => getAuthSnapshot() !== null);
  const [stored, setStored] = useState<Set<string> | null>(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [test, setTest] = useState<"idle" | "testing" | "ok">("idle");

  useEffect(() => {
    const onAuth = () => setSignedIn(getAuthSnapshot() !== null);
    window.addEventListener(AUTH_CHANGED_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuth);
  }, []);

  const failed = useCallback((e: unknown) => c.failed.replace("{error}", e instanceof Error ? e.message : String(e)), [c.failed]);

  const refresh = async () => {
    try {
      setStored(new Set(await listCloudSecrets()));
      setError("");
      return true;
    } catch (e) {
      setError(failed(e));
      return false;
    }
  };

  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    listCloudSecrets()
      .then((keys) => {
        if (!alive) return;
        setStored(new Set(keys));
        setError("");
      })
      .catch((e) => alive && setError(failed(e)));
    return () => {
      alive = false;
    };
  }, [signedIn, failed]);

  const change = async (key: string, value: string | null) => {
    setBusyKey(key);
    try {
      if (value === null) await deleteCloudSecret(key);
      else await putCloudSecrets([{ key, value }]);
      await refresh();
    } catch (e) {
      setError(failed(e));
    } finally {
      setBusyKey(null);
    }
  };

  const runTest = async () => {
    setTest("testing");
    setTest((await refresh()) ? "ok" : "idle");
  };

  // Providers with a key on this computer; agent CLIs sign in their own way (below).
  const withKey = (Object.keys(PROVIDERS) as ProviderId[]).filter(
    (id) => !(id in CLI_CLOUD_KEYS) && settings[id]?.apiKey?.trim(),
  );

  return (
    <div className="space-y-10">
      <SectionTitle>{c.nav}</SectionTitle>
      <p className="text-sm text-text-300 leading-relaxed -mt-6">{c.intro}</p>

      {!signedIn ? (
        <p className="text-sm text-text-400">{c.signedOut}</p>
      ) : (
        <>
          <section>
            <h3 className="text-sm font-semibold text-text-100">{c.providersHeading}</h3>
            <p className="text-[12px] text-text-400 mt-0.5 mb-2">{c.providersIntro}</p>
            {withKey.length === 0 ? (
              <p className="text-[12px] text-text-400 border-t border-bg-300 pt-4">{c.noProviders}</p>
            ) : (
              <ul className="divide-y divide-bg-300 border-t border-bg-300">
                {withKey.map((id) => {
                  const support = cloudSupport(id, settings);
                  const key = providerCloudKey(id);
                  const on = stored?.has(key) ?? false;
                  if (!support.ok) {
                    return (
                      <Row key={id} title={PROVIDERS[id].name} desc={support.reason === "local" ? c.localOnly : c.cliOnly}>
                        <DisabledToggle />
                      </Row>
                    );
                  }
                  return (
                    <Row key={id} title={PROVIDERS[id].name} desc={on ? c.synced : c.notSynced}>
                      {busyKey === key ? (
                        <Loader2 className="w-4 h-4 mt-1 animate-spin text-text-400" />
                      ) : (
                        <SettingsToggle
                          label={PROVIDERS[id].name}
                          checked={on}
                          onChange={(v) => void change(key, v ? settings[id].apiKey.trim() : null)}
                        />
                      )}
                    </Row>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-text-100 mb-2">{c.accountsHeading}</h3>
            <ul className="divide-y divide-bg-300 border-t border-bg-300">
              <TokenRow
                title={PROVIDERS["claude-code"].name}
                desc={c.claudeDesc}
                stored={stored?.has(CLI_CLOUD_KEYS["claude-code"]) ?? false}
                onSave={(v) => change(CLI_CLOUD_KEYS["claude-code"], v)}
                onRemove={() => change(CLI_CLOUD_KEYS["claude-code"], null)}
              />
              <TokenRow
                title="GitHub"
                desc={c.githubDesc}
                stored={stored?.has(GITHUB_CLOUD_KEY) ?? false}
                onSave={(v) => change(GITHUB_CLOUD_KEY, v)}
                onRemove={() => change(GITHUB_CLOUD_KEY, null)}
              />
            </ul>
          </section>

          <section className="flex items-center gap-3">
            <button type="button" className={buttonClass} disabled={test === "testing"} onClick={() => void runTest()}>
              {test === "testing" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {test === "testing" ? c.testing : c.test}
            </button>
            {error ? (
              <p className="text-[12px] text-red-400 min-w-0">{error}</p>
            ) : (
              test === "ok" && stored && (
                <p className="inline-flex items-center gap-1.5 text-[12px] text-text-300">
                  <Check className="w-3.5 h-3.5 text-green-500" />
                  {c.testOk.replace("{n}", String(stored.size))}
                </p>
              )
            )}
          </section>
        </>
      )}
    </div>
  );
}
