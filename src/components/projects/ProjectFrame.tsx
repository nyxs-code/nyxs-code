import { useState, type ReactNode } from "react";
import { ChevronRight, Cloud, Folder, GitPullRequest, Laptop, PanelRight, Settings2, Square } from "lucide-react";
import { openExternalUrl } from "@/lib/openExternal";
import { projectHost } from "@/lib/projects/projectHost";
import { Button } from "@/components/ui/button";
import { GithubMark } from "@/components/customize/logos";
import { useTranslations } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import { cn } from "@/lib/utils";
import { workspaceName } from "@/lib/workspace";
import type { Chat } from "@/lib/chatStore";
import { projectEntry, useProjectDirectory } from "@/lib/projects/projectDirectory";
import type { Project } from "@/lib/projects/types";
import { ProjectDialog } from "./ProjectDialog";
import { ProjectOverview } from "./ProjectOverview";

const PANEL_KEY = "nyxs.projectOverview.hidden";

const repoLabel = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/^github\.com\//, "").replace(/\.git$/, "");

/** A project's session on screen: the header (project › thread, its repos and where it runs),
 *  the conversation, and the overview panel at its right. */
export function ProjectFrame({
  chat,
  children,
  models,
  defaultModel,
  onOpenProject,
  onOpenScheduled,
  onSave,
  onDelete,
}: {
  chat: Chat;
  children: ReactNode;
  models: { id: string; name: string; provider?: string }[];
  defaultModel: string;
  onOpenProject: (projectId: string) => void;
  onOpenScheduled: () => void;
  onSave: (project: Project) => Promise<unknown>;
  onDelete: (projectId: string) => Promise<unknown>;
}) {
  const t = useTranslations().projects;
  const tm = useTranslations().modals;
  useProjectDirectory();
  const entry = projectEntry(chat.projectId);
  const [editing, setEditing] = useState(false);
  const [panelHidden, setPanelHidden] = useState(() => localStorage.getItem(PANEL_KEY) === "1");
  const [confirm, confirmElement] = useConfirm();
  if (!entry) return <>{children}</>;
  const { project } = entry;
  const isThread = chat.projectRole === "thread";
  const thread = isThread ? entry.threads.find((x) => x.id === chat.id) : undefined;
  // A thread shows where it runs; the coordinator, where the project's threads run by default.
  const inCloud = isThread ? chat.threadLocation?.kind === "cloud" : project.defaults.where === "cloud";
  const cloudWorking = isThread && chat.threadLocation?.kind === "cloud" && thread?.group === "working";
  const togglePanel = () => {
    setPanelHidden((h) => {
      localStorage.setItem(PANEL_KEY, h ? "0" : "1");
      return !h;
    });
  };
  const askDelete = async () => {
    const ok = await confirm({
      title: t.deleteTitle.replace("{name}", project.name),
      message: t.deleteBody,
      confirmLabel: t.deleteProject,
      cancelLabel: tm.cancel,
      danger: true,
    });
    if (!ok) return;
    setEditing(false);
    await onDelete(project.id);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-bg-300">
        <nav aria-label={t.navLabel} className="flex min-w-0 items-center gap-1 text-[14px]">
          {isThread ? (
            <button type="button" onClick={() => onOpenProject(project.id)} className="shrink-0 max-w-[16rem] truncate rounded-[6px] px-1 text-text-300 hover:text-text-100">
              {project.name}
            </button>
          ) : (
            <span className="shrink-0 max-w-[20rem] truncate px-1 font-medium text-text-100">{project.name}</span>
          )}
          {isThread && (
            <>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-500" />
              <span aria-current="page" className="min-w-0 truncate px-1 font-medium text-text-100">{chat.title || chat.threadTitle}</span>
            </>
          )}
        </nav>
        <div className="ml-2 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {project.repos.map((r, i) => (
            <span key={i} className="inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-[6px] bg-bg-200 px-2 text-[12px] text-text-300">
              {r.gitUrl ? <GithubMark className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{r.gitUrl ? repoLabel(r.gitUrl) : workspaceName(r.path ?? "")}</span>
            </span>
          ))}
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] bg-bg-200 px-2 text-[12px] text-text-300">
            {inCloud ? <Cloud className="h-3.5 w-3.5" /> : <Laptop className="h-3.5 w-3.5" />}
            {inCloud ? t.cloud : t.thisComputer}
          </span>
          {thread?.prUrl && (
            <button type="button" onClick={() => openExternalUrl(thread.prUrl!)} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] bg-bg-200 px-2 text-[12px] text-text-300 hover:text-text-100">
              <GitPullRequest className="h-3.5 w-3.5" />
              {t.openPr}
            </button>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {cloudWorking && (
            <Button variant="secondary" className="mr-1" onClick={() => void projectHost()?.stopThread(chat.id)}>
              <Square className="h-3 w-3" />
              {t.stopThread}
            </Button>
          )}
          <Button variant="ghost" icon aria-label={t.settings} onClick={() => setEditing(true)}>
            <Settings2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" icon aria-label={t.tabThreads} aria-pressed={!panelHidden} onClick={togglePanel}>
            <PanelRight className={cn("h-4 w-4", !panelHidden && "text-text-100")} />
          </Button>
        </div>
      </header>
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">{children}</div>
        {!panelHidden && <ProjectOverview entry={entry} activeId={chat.id} onOpenScheduled={onOpenScheduled} />}
      </div>
      {editing && (
        <ProjectDialog project={project} models={models} defaultModel={defaultModel} onClose={() => setEditing(false)} onSave={onSave} onDelete={() => void askDelete()} />
      )}
      {confirmElement}
    </div>
  );
}
