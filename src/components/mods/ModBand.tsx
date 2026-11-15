import { useEffect, useState, useSyncExternalStore } from "react";
import { Blocks } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { modHost } from "@/lib/mods/io";
import type { BandRow } from "@/lib/mods/host";
import { ModTree } from "./ModTree";

/** Asks once per session before the mods the agent wrote there load. */
function DevModsConsent({ sessionKey }: { sessionKey: string }) {
  const t = useTranslations().mods;
  const [explained, setExplained] = useState(false);
  return (
    <div role="alertdialog" aria-label={t.consentQuestion} className="mb-2 rounded-[8px] border border-bg-300 bg-bg-100 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Blocks className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-text-100">{t.consentQuestion}</p>
          {explained && <p className="mt-1 text-[12.5px] leading-snug text-text-300">{t.consentExplain}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {!explained && (
              <button type="button" onClick={() => setExplained(true)} className="h-7 rounded-[6px] px-2.5 text-[12.5px] text-text-300 hover:bg-bg-200 hover:text-text-100">
                {t.consentHow}
              </button>
            )}
            <button type="button" onClick={() => void modHost.answerDevConsent(sessionKey, true)} className="h-7 rounded-[6px] bg-accent px-2.5 text-[12.5px] text-white hover:bg-accent-hover">
              {t.consentOn}
            </button>
            <button type="button" onClick={() => void modHost.answerDevConsent(sessionKey, false)} className="h-7 rounded-[6px] border border-bg-300 px-2.5 text-[12.5px] text-text-200 hover:bg-bg-200">
              {t.consentOff}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The band above the chat box: what the session's mods draw there (`AbovePrompt`), their
 * status lines, and the question before the mods the agent wrote load.
 */
export function ModBand({ sessionKey, isWorking }: { sessionKey: string; isWorking: boolean }) {
  const version = useSyncExternalStore(modHost.subscribe, modHost.getVersion);
  const [rows, setRows] = useState<BandRow[]>([]);

  useEffect(() => {
    let live = true;
    void modHost.renderBand(sessionKey, isWorking).then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, [sessionKey, isWorking, version]);

  const status = modHost.status(sessionKey);
  const asking = modHost.devConsentPending(sessionKey);
  if (!rows.length && !status.length && !asking) return null;
  return (
    <div className="mx-2 md:mx-0">
      {asking && <DevModsConsent sessionKey={sessionKey} />}
      {rows.map((r) => (
        <div key={r.plugin} className="custom-scrollbar mb-2 max-h-[45vh] overflow-y-auto rounded-[8px] border border-bg-300 bg-bg-100 px-3 py-2.5 text-text-200">
          <ModTree tree={r.tree} onPress={(fn, args) => modHost.press(sessionKey, r.plugin, fn, args)} />
        </div>
      ))}
      {status.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-x-3 px-1 text-[12px] text-text-400">
          {status.map((s) => (
            <span key={s.plugin} className="truncate">
              {s.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
