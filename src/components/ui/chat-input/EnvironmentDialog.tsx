import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Folder, Layers } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { localizedError, useTranslations } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import { deleteEnvironment, environmentVariablesText, parseEnvText, saveEnvironment, type SavedEnvironment } from "@/lib/environments";
import { workspaceName } from "@/lib/workspace";

const field = "w-full rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 py-1.5 text-[13px] text-text-100 placeholder:text-text-500 focus:border-accent focus:outline-none";

/** New or edit a saved environment, like Claude Code Desktop's: a name, the folder sessions
 *  start in, whether they get their own worktree, and `KEY=value` variables (kept encrypted). */
export function EnvironmentDialog({ env, defaultFolder, onClose, onSaved }: {
  env: SavedEnvironment | null;
  defaultFolder: string | null;
  onClose: () => void;
  onSaved: (env: SavedEnvironment) => void;
}) {
  const t = useTranslations().environments;
  const [name, setName] = useState(env?.name ?? "");
  const [folder, setFolder] = useState(env?.folder ?? defaultFolder ?? "");
  const [worktree, setWorktree] = useState(env?.worktree ?? false);
  const [vars, setVars] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();

  useEffect(() => {
    if (!env) return;
    let alive = true;
    void environmentVariablesText(env.id).then((v) => { if (alive) setVars(v); });
    return () => { alive = false; };
  }, [env]);

  const bad = parseEnvText(vars).bad;
  const pick = async () => {
    const dir = await openDialog({ directory: true, defaultPath: folder || undefined }).catch(() => null);
    if (typeof dir === "string") setFolder(dir);
  };
  const save = async () => {
    if (!folder || bad.length) return;
    setSaving(true);
    setSaveError(null);
    let saved: SavedEnvironment;
    try {
      saved = await saveEnvironment({ id: env?.id, name: name.trim() || workspaceName(folder), folder, worktree }, vars.trim());
    } catch (e) {
      // Left as it was, with Save back on to try again.
      setSaveError(t.saveFailed.replace("{error}", localizedError(e)));
      return;
    } finally {
      setSaving(false);
    }
    onSaved(saved);
    onClose();
  };
  const remove = async (target: SavedEnvironment) => {
    const ok = await confirm({
      title: t.deleteConfirm.replace("{name}", target.name),
      confirmLabel: t.deleteConfirmAction,
      cancelLabel: t.cancel,
      danger: true,
    });
    if (!ok) return;
    await deleteEnvironment(target.id);
    onClose();
  };

  return (
    <>
      <Dialog open onClose={onClose} stacked className="max-w-lg">
        <DialogHeader>
          <Layers className="h-4 w-4 text-accent" />
          <DialogTitle>{env ? t.editTitle : t.newTitle}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 px-4 pb-2">
          <label className="block">
            <span className="mb-1 block text-[12.5px] text-text-300">{t.name}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={folder ? workspaceName(folder) : t.namePlaceholder} className={field} />
          </label>
          <div>
            <span className="mb-1 block text-[12.5px] text-text-300">{t.folder}</span>
            <div className="flex items-center gap-2">
              <span className={`${field} flex min-w-0 flex-1 items-center gap-1.5 truncate`}>
                <Folder className="h-3.5 w-3.5 shrink-0 text-text-400" />
                <span className="truncate">{folder || t.noFolder}</span>
              </span>
              <Button onClick={() => void pick()}>{t.choose}</Button>
            </div>
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="block text-[13px] text-text-100">{t.worktree}</span>
              <span className="block text-[12px] text-text-400">{t.worktreeDesc}</span>
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12.5px] text-text-300">{t.variables}</span>
            <textarea
              value={vars}
              onChange={(e) => setVars(e.target.value)}
              rows={5}
              spellCheck={false}
              placeholder={"API_URL=http://localhost:3000\nFEATURE_FLAG=on"}
              className={`${field} resize-y font-mono text-[12.5px]`}
            />
            <span className={`mt-1 block text-[12px] ${bad.length ? "text-red-500" : "text-text-400"}`}>
              {bad.length ? t.badLines.replace("{lines}", bad.join(", ")) : t.variablesDesc}
            </span>
          </label>
          {saveError && <p role="alert" className="text-[12px] text-red-500">{saveError}</p>}
        </div>
        <DialogFooter>
          {env && (
            <Button variant="ghost" className="mr-auto text-red-500" onClick={() => void remove(env)}>
              {t.delete}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
          <Button variant="primary" onClick={() => void save()} disabled={!folder || bad.length > 0 || saving}>
            {env ? t.save : t.create}
          </Button>
        </DialogFooter>
      </Dialog>
      {confirmElement}
    </>
  );
}
