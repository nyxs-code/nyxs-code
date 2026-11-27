import { useState } from "react";
import { Folder, X } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SettingSelect } from "@/components/settings/SettingSelect";
import { useTranslations } from "@/lib/i18n";
import { pickWorkspace } from "@/lib/workspace";
import { projectFolder } from "@/lib/projects/projectStore";
import { repoUrlOf } from "@/lib/projects/repoSuggestions";
import { PROJECT_INSTRUCTIONS_MAX, type Project, type ProjectRepo, type ThreadWhere } from "@/lib/projects/types";
import { cloudSupport } from "@/lib/cloud/cloudCredentials";
import { PROVIDERS, type ProviderId } from "@/lib/models";
import { DARK_BUTTON } from "@/lib/projects/projectUi";
import { cn } from "@/lib/utils";
import { ProjectIcon } from "./ProjectIcon";
import { WhereChoice } from "./WhereChoice";

const FIELD = "w-full h-9 px-3 rounded-[6px] bg-bg-200 border border-transparent text-[14px] text-text-100 placeholder:text-text-400 outline-none focus:border-accent";
const LABEL = "block text-[13px] text-text-200 mb-1.5";

/** The project's repositories with the linked folder and the first URL as edited here; the
 *  other URLs stay. */
function editedRepos(project: Project, folder: string, url: string | null): ProjectRepo[] {
  const others = project.repos.filter((r) => r.gitUrl).slice(1).map((r) => ({ gitUrl: r.gitUrl!, ...(r.branch ? { branch: r.branch } : {}) }));
  const firstBranch = project.repos.find((r) => r.gitUrl)?.branch;
  return [...(folder ? [{ path: folder }] : []), ...(url ? [{ gitUrl: url, ...(firstBranch ? { branch: firstBranch } : {}) }] : []), ...others];
}

/** A project's settings: its name, linked folder, repository, instructions, and where its
 *  threads run and on which model (creation leaves these to their defaults, as in Claude). */
export function ProjectDialog({
  project,
  models,
  defaultModel,
  onClose,
  onSave,
  onDelete,
}: {
  project: Project;
  models: { id: string; name: string; provider?: string }[];
  /** The app's model, which threads use when the project names none. */
  defaultModel: string;
  onClose: () => void;
  onSave: (project: Project) => Promise<unknown>;
  onDelete?: () => void;
}) {
  const t = useTranslations().projects;
  const tm = useTranslations().modals;
  const [name, setName] = useState(project.name);
  const [folder, setFolder] = useState(projectFolder(project) ?? "");
  const [gitUrl, setGitUrl] = useState(project.repos.find((r) => r.gitUrl)?.gitUrl ?? "");
  const [instructions, setInstructions] = useState(project.instructions);
  const [model, setModel] = useState(project.defaults.model ?? "");
  const [where, setWhere] = useState<ThreadWhere>(project.defaults.where);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = repoUrlOf(gitUrl);
  // The cloud clones the repository and runs the threads' model there; local threads need a
  // folder on this computer.
  const provider = models.find((m) => m.id === (model || defaultModel))?.provider as ProviderId | undefined;
  const cloudBlocked = !url ? t.cloudNeedsRepo : provider && PROVIDERS[provider] && !cloudSupport(provider).ok ? t.cloudModelUnsupported : undefined;
  const localBlocked = !folder ? t.needFolder : undefined;
  const shownWhere: ThreadWhere = cloudBlocked && !localBlocked ? "local" : localBlocked && !cloudBlocked ? "cloud" : where;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const { model: _old, ...defaults } = project.defaults;
      await onSave({
        ...project,
        name: name.trim() || project.name,
        repos: editedRepos(project, folder, url),
        instructions: instructions.trim(),
        defaults: { ...defaults, ...(model ? { model } : {}), where: shownWhere },
      });
      onClose();
    } catch (e) {
      console.warn("[projects] saving failed:", e);
      setError(t.createFailed);
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-[520px] max-h-[min(720px,100%)] overflow-hidden flex flex-col">
      <DialogHeader className="px-5 pt-4 pb-2">
        <ProjectIcon className="w-4 h-4 text-text-300" />
        <DialogTitle className="text-[14px] font-semibold">{t.editTitle}</DialogTitle>
      </DialogHeader>
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 pb-4">
        <label className={LABEL} htmlFor="project-name">{t.nameLabel}</label>
        <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={FIELD} />

        <p className={cn(LABEL, "mt-4")}>{t.linkFolder} <span className="text-text-400">{t.optional}</span></p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void pickWorkspace().then((p) => p && setFolder(p)).catch(() => undefined)}
            className="min-w-0 flex-1 h-9 px-3 rounded-[6px] border border-bg-300 bg-bg-100 flex items-center gap-2 text-left text-[14px] hover:bg-bg-200 transition-colors"
          >
            <Folder className="w-4 h-4 shrink-0 text-text-400" />
            <span className={cn("min-w-0 flex-1 truncate", folder ? "text-text-100" : "text-text-400")}>{folder || t.chooseFolder}</span>
          </button>
          {folder && (
            <Button variant="ghost" icon aria-label={t.remove} onClick={() => setFolder("")}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <label className={cn(LABEL, "mt-4")} htmlFor="project-url">{t.repoUrlLabel}</label>
        <input id="project-url" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder={t.repoInputPlaceholder} className={FIELD} spellCheck={false} />

        <label className={cn(LABEL, "mt-4")} htmlFor="project-instructions">{t.goalLabel}</label>
        <textarea
          id="project-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value.slice(0, PROJECT_INSTRUCTIONS_MAX))}
          placeholder={t.instructionsPlaceholder}
          rows={5}
          className="block w-full px-3 py-2 rounded-[6px] bg-bg-200 border border-transparent text-[14px] text-text-100 placeholder:text-text-400 outline-none focus:border-accent resize-y min-h-[96px]"
        />

        <div className="mt-4 flex items-center gap-3">
          <span className="flex-1 text-[13px] text-text-200">{t.modelLabel}</span>
          <SettingSelect<string>
            ariaLabel={t.modelLabel}
            value={model}
            options={[{ id: "", label: t.modelDefault }, ...models.map((m) => ({ id: m.id, label: m.name }))]}
            onChange={setModel}
          />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span className="flex-1 text-[13px] text-text-200">{t.whereLabel}</span>
          <WhereChoice value={shownWhere} onChange={setWhere} cloudBlocked={cloudBlocked} localBlocked={localBlocked} />
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-text-400">{shownWhere === "cloud" ? t.cloudHint : (cloudBlocked ?? t.cloudHint)}</p>

        {error && <p role="alert" className="mt-3 text-[13px] text-red-400">{error}</p>}
      </div>
      <DialogFooter>
        {onDelete && (
          <Button variant="ghost" className="mr-auto text-red-400 hover:text-red-300" onClick={onDelete}>{t.deleteProject}</Button>
        )}
        <Button variant="ghost" className="bg-bg-200 text-text-100 hover:bg-bg-300" onClick={onClose}>{tm.cancel}</Button>
        <Button className={DARK_BUTTON} disabled={busy} onClick={() => void save()}>{t.save}</Button>
      </DialogFooter>
    </Dialog>
  );
}
