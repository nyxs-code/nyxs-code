import { useState } from "react";
import { Folder, FolderKanban } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SettingSelect } from "@/components/settings/SettingSelect";
import { useTranslations } from "@/lib/i18n";
import { pickWorkspace, workspaceName } from "@/lib/workspace";
import { projectFolder } from "@/lib/projects/projectStore";
import { PROJECT_INSTRUCTIONS_MAX, type Project } from "@/lib/projects/types";
import type { NewProject } from "@/lib/projects/useProjects";
import { cn } from "@/lib/utils";
import { WhereChoice } from "./WhereChoice";

const FIELD = "w-full h-9 px-3 rounded-[6px] bg-bg-200 border border-transparent text-[14px] text-text-100 placeholder:text-text-400 outline-none focus:border-accent";
const LABEL = "block text-[13px] font-medium text-text-100 mb-1.5";

/** A new project (name, folder, optional repo URL, instructions, threads' model and where), or
 *  the settings of one (`project`). */
export function ProjectDialog({
  project,
  models,
  onClose,
  onCreate,
  onSave,
  onDelete,
}: {
  project?: Project;
  models: { id: string; name: string }[];
  onClose: () => void;
  onCreate?: (input: NewProject) => Promise<unknown>;
  onSave?: (project: Project) => Promise<unknown>;
  onDelete?: () => void;
}) {
  const t = useTranslations().projects;
  const tm = useTranslations().modals;
  const [name, setName] = useState(project?.name ?? "");
  const [folder, setFolder] = useState(projectFolder(project) ?? "");
  const [gitUrl, setGitUrl] = useState(project?.repos.find((r) => r.gitUrl)?.gitUrl ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const [model, setModel] = useState(project?.defaults.model ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const choose = async () => {
    const picked = await pickWorkspace().catch(() => null);
    if (!picked) return;
    setFolder(picked);
    if (!name.trim()) setName(workspaceName(picked));
  };

  const submit = async () => {
    if (!folder) {
      setError(t.needFolder);
      return;
    }
    setBusy(true);
    setError("");
    const shownName = name.trim() || workspaceName(folder);
    try {
      if (project) {
        const repos = [{ path: folder, ...(gitUrl.trim() ? { gitUrl: gitUrl.trim() } : {}) }, ...project.repos.slice(1)];
        const { model: _old, ...defaults } = project.defaults;
        await onSave?.({ ...project, name: shownName, repos, instructions, defaults: { ...defaults, ...(model ? { model } : {}) } });
      } else {
        await onCreate?.({ name: shownName, folder, gitUrl, instructions, model: model || undefined, where: "local" });
      }
      onClose();
    } catch (e) {
      console.warn("[projects] saving failed:", e);
      setError(t.createFailed);
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-[560px] max-h-[min(720px,100%)] overflow-hidden flex flex-col">
      <DialogHeader className="px-5 pt-4 pb-2">
        <FolderKanban className="w-4 h-4 text-accent" />
        <DialogTitle className="text-[16px] font-medium">{project ? t.editTitle : t.createTitle}</DialogTitle>
      </DialogHeader>
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 pb-4">
        <label className={LABEL} htmlFor="project-name">{t.nameLabel}</label>
        <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePlaceholder} maxLength={80} className={FIELD} />

        <p className={cn(LABEL, "mt-4")}>{t.folderLabel}</p>
        <button
          type="button"
          onClick={() => void choose()}
          className="w-full h-9 px-3 rounded-[6px] border border-bg-300 bg-bg-100 flex items-center gap-2 text-left text-[14px] hover:bg-bg-200 transition-colors"
        >
          <Folder className="w-4 h-4 shrink-0 text-text-400" />
          <span className={cn("min-w-0 flex-1 truncate", folder ? "text-text-100" : "text-text-400")}>{folder || t.chooseFolder}</span>
        </button>

        <label className={cn(LABEL, "mt-4")} htmlFor="project-url">{t.repoUrlLabel}</label>
        <input id="project-url" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder={t.repoUrlPlaceholder} className={FIELD} spellCheck={false} />

        <label className={cn(LABEL, "mt-4")} htmlFor="project-instructions">{t.instructionsLabel}</label>
        <textarea
          id="project-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value.slice(0, PROJECT_INSTRUCTIONS_MAX))}
          placeholder={t.instructionsPlaceholder}
          rows={5}
          className="block w-full px-3 py-2 rounded-[6px] bg-bg-200 border border-transparent text-[14px] text-text-100 placeholder:text-text-400 outline-none focus:border-accent resize-y min-h-[96px]"
        />

        <div className="mt-4 flex items-center gap-3">
          <span className="flex-1 text-[13px] font-medium text-text-100">{t.modelLabel}</span>
          <SettingSelect<string>
            ariaLabel={t.modelLabel}
            value={model}
            options={[{ id: "", label: t.modelDefault }, ...models.map((m) => ({ id: m.id, label: m.name }))]}
            onChange={setModel}
          />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span className="flex-1 text-[13px] font-medium text-text-100">{t.whereLabel}</span>
          <WhereChoice />
        </div>

        {error && <p role="alert" className="mt-3 text-[13px] text-red-400">{error}</p>}
      </div>
      <DialogFooter>
        {project && onDelete && (
          <Button variant="ghost" className="mr-auto text-red-400 hover:text-red-300" onClick={onDelete}>{t.deleteProject}</Button>
        )}
        <Button variant="ghost" onClick={onClose}>{tm.cancel}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>{project ? t.save : t.create}</Button>
      </DialogFooter>
    </Dialog>
  );
}
