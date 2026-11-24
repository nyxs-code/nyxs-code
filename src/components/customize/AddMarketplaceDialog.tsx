import { useState } from "react";
import { GitBranch, Library, Loader2 } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { addMarketplace, getCatalog, removeMarketplace } from "@/lib/plugins";
import { localizedError, useTranslations } from "@/lib/i18n";
import { notifyPluginsChanged } from "./usePluginsData";

function Choice({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-4 text-left px-4 py-4 rounded-[8px] border border-bg-300 hover:bg-bg-200/60 transition-colors"
    >
      <span className="w-5 shrink-0 flex justify-center text-text-200">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[14px] text-text-100">{title}</span>
        <span className="block text-[13px] text-text-400 mt-0.5">{hint}</span>
      </span>
    </button>
  );
}

/** "Add marketplace": browse the official sources, or sync one from a GitHub repo or Git URL. */
export function AddMarketplaceDialog({
  onClose,
  onBrowseOfficial,
  stacked,
}: {
  onClose: () => void;
  onBrowseOfficial: () => void;
  stacked?: boolean;
}) {
  const t = useTranslations().customizePage;
  const [step, setStep] = useState<"choose" | "repo">("choose");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const value = source.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    let added: string | null = null;
    try {
      const mp = await addMarketplace(value, { autoUpdate: true });
      added = mp.name;
      // Reads its catalog now: a wrong address fails here instead of in the list later.
      await getCatalog(mp, { force: true });
      notifyPluginsChanged();
      onClose();
    } catch (e) {
      if (added) await removeMarketplace(added).catch(() => undefined);
      setError(localizedError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} stacked={stacked} className="max-w-[520px]">
      <DialogHeader className="px-4 pt-4 pb-2">
        <DialogTitle className="text-[15px] font-medium">{t.addMarketplace}</DialogTitle>
      </DialogHeader>
      {step === "choose" ? (
        <div className="px-4 pt-1 space-y-3">
          <Choice
            icon={<Library className="w-5 h-5" strokeWidth={1.5} />}
            title={t.browseOfficial}
            hint={t.browseOfficialHint}
            onClick={onBrowseOfficial}
          />
          <Choice
            icon={<GitBranch className="w-5 h-5" strokeWidth={1.5} />}
            title={t.addFromRepo}
            hint={t.addFromRepoHint}
            onClick={() => setStep("repo")}
          />
        </div>
      ) : (
        <form
          className="px-4 pt-1 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block text-[13px] text-text-300">{t.repoLabel}</label>
          <input
            autoFocus
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="owner/repo · https://github.com/owner/repo.git"
            className="w-full h-9 px-3 text-[13px] rounded-[6px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono"
          />
          <p className="text-[12px] text-text-400">{t.repoHint}</p>
          {error && <p className="text-[12px] text-red-400 break-words">{error}</p>}
        </form>
      )}
      <DialogFooter>
        {step === "repo" && (
          <Button variant="ghost" onClick={() => { setStep("choose"); setError(null); }}>
            {t.back}
          </Button>
        )}
        <Button onClick={onClose}>{t.cancel}</Button>
        {step === "repo" && (
          <Button variant="primary" disabled={busy || !source.trim()} onClick={() => void submit()}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t.add}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
