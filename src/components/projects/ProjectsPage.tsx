import { useState } from "react";
import { ChevronRight, FolderKanban, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { workspaceName } from "@/lib/workspace";
import { relativeTime } from "@/lib/time";
import { useProjectDirectory } from "@/lib/projects/projectDirectory";
import { projectFolder } from "@/lib/projects/projectStore";
import { GROUP_DOT, THREAD_GROUPS } from "@/lib/projects/threadStatus";
import type { NewProject } from "@/lib/projects/useProjects";
import { ProjectDialog } from "./ProjectDialog";

/** The Projects page (sidebar "Proyectos · Beta"): every project with its threads at a glance,
 *  or, before the first one, what a project is and "Nuevo proyecto". */
export function ProjectsPage({
  loaded,
  models,
  defaultModel,
  onOpen,
  onCreate,
}: {
  loaded: boolean;
  models: { id: string; name: string; provider?: string }[];
  defaultModel: string;
  onOpen: (projectId: string) => void;
  onCreate: (input: NewProject) => Promise<unknown>;
}) {
  const t = useTranslations().projects;
  const entries = useProjectDirectory();
  const [creating, setCreating] = useState(false);
  const groupLabel = { waiting: t.groupWaiting, working: t.groupWorking, review: t.groupReview, resolved: t.groupResolved, failed: t.groupFailed };

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="max-w-[960px] mx-auto px-8 pt-14 pb-16">
        <div className="flex items-center mb-8">
          <h1 className="text-[28px] font-serif text-text-100">{t.navLabel}</h1>
          <span className="ml-2.5 mt-1 rounded-[4px] bg-bg-200 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-400">{t.beta}</span>
          {entries.length > 0 && (
            <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              {t.newProject}
            </Button>
          )}
        </div>

        {loaded && entries.length === 0 && (
          <div className="mx-auto mt-16 max-w-md text-center">
            <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-[8px] bg-bg-200 text-text-300">
              <FolderKanban className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <h2 className="text-[18px] font-medium text-text-100">{t.emptyTitle}</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-text-300">{t.emptyBody}</p>
            <Button variant="primary" className="mt-6" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              {t.newProject}
            </Button>
          </div>
        )}

        {entries.length > 0 && (
          <div className="flex flex-col">
            {entries.map((e, i) => {
              const folder = projectFolder(e.project);
              const counts = THREAD_GROUPS.map((g) => [g, e.threads.filter((x) => x.group === g).length] as const).filter(([, n]) => n > 0);
              const last = e.threads[0]?.updatedAt ?? e.project.createdAt;
              return (
                <button
                  key={e.project.id}
                  type="button"
                  onClick={() => onOpen(e.project.id)}
                  className="group -mx-3 px-3 rounded-[8px] text-left hover:bg-bg-200/70 transition-colors"
                >
                  <span className={cn("flex items-center gap-3 py-3.5", i < entries.length - 1 && "border-b border-bg-300 group-hover:border-transparent")}>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-bg-200 text-text-300">
                      <FolderKanban className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[14px] text-text-100">{e.project.name}</span>
                        {e.dot && <span className={cn("h-2 w-2 shrink-0 rounded-full", GROUP_DOT[e.dot])} />}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 truncate text-[13px] text-text-400">
                        {folder && <span className="truncate">{workspaceName(folder)}</span>}
                        <span>·</span>
                        <span className="shrink-0">{t.threadsCount.replace("{count}", String(e.threads.length))}</span>
                        <span>·</span>
                        <span className="shrink-0">{relativeTime(last, getLanguage())}</span>
                      </span>
                      {counts.length > 0 && (
                        <span className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-text-300">
                          {counts.map(([g, n]) => (
                            <span key={g} className="inline-flex items-center gap-1.5">
                              <span className={cn("h-1.5 w-1.5 rounded-full", GROUP_DOT[g])} />
                              {groupLabel[g]} {n}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-text-400" />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {creating && <ProjectDialog models={models} defaultModel={defaultModel} onClose={() => setCreating(false)} onCreate={onCreate} />}
    </div>
  );
}
