import { useEffect, useState } from "react";
import { CloudUpload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getRagConsent, setRagConsent } from "@/lib/globalConfig";
import { useTranslations } from "@/lib/i18n";
import { ragConfig } from "@/lib/rag";
import { useSettings } from "@/lib/useSettings";

/**
 * Asks once per project, when it opens with "Semantic search on the Nyxs service" on in
 * Settings › Privacy, whether its files may be sent to be indexed. Either answer is kept for the
 * project; closing it without one asks again next time. "Index" starts indexing (`onIndex`).
 */
export function RagConsentDialog({ workspace, onIndex }: { workspace: string | null; onIndex: (workspace: string) => void }) {
  const t = useTranslations().ragConsent;
  const { perSource } = useSettings();
  // The user's own setting: a project's settings can't ask for its own upload.
  const wanted = (perSource.user as { privacy?: { semanticSearch?: boolean } } | undefined)?.privacy?.semanticSearch === true;
  // The project being asked about; shown only while it's still the open one.
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace || !wanted || ragConfig().provider === "mock") return;
    let alive = true;
    void getRagConsent(workspace).then((consent) => {
      if (alive && consent === undefined) setPending(workspace);
    });
    return () => {
      alive = false;
    };
  }, [workspace, wanted]);

  const asking = wanted && pending === workspace ? pending : null;
  if (!asking) return null;
  const answer = (granted: boolean) => {
    setPending(null);
    void setRagConsent(asking, granted ? "granted" : "declined").then(() => {
      if (granted) onIndex(asking);
    });
  };

  return (
    <Dialog open onClose={() => setPending(null)} role="alertdialog" describedBy="rag-consent-body">
      <DialogHeader close={false}>
        <CloudUpload className="w-4 h-4 text-accent" />
        <DialogTitle>{t.title}</DialogTitle>
      </DialogHeader>
      <div className="px-4">
        <p id="rag-consent-body" className="text-[13px] text-text-300 leading-relaxed">{t.body}</p>
        <p className="mt-2.5 text-xs font-mono text-text-200 break-all bg-bg-200 rounded-[6px] px-2.5 py-2">{asking}</p>
        <p className="mt-2.5 text-[12px] text-text-400 leading-relaxed">{t.note}</p>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => answer(false)}>{t.notNow}</Button>
        <Button variant="primary" onClick={() => answer(true)}>{t.index}</Button>
      </DialogFooter>
    </Dialog>
  );
}
