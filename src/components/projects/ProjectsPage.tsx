import { useState, type ComponentType, type ReactNode } from "react";
import { Brain, ChevronRight, Cloud, CornerDownLeft, Laptop, MessageCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { workspaceName } from "@/lib/workspace";
import { relativeTime } from "@/lib/time";
import { useProjectDirectory } from "@/lib/projects/projectDirectory";
import { projectFolder } from "@/lib/projects/projectStore";
import { repoLabel } from "@/lib/projects/repoSuggestions";
import { repliesLabel } from "@/lib/projects/threadLabels";
import { DARK_BUTTON } from "@/lib/projects/projectUi";
import { GROUP_DOT, THREAD_GROUPS } from "@/lib/projects/threadStatus";
import type { NewProject } from "@/lib/projects/useProjects";
import { CloudInfoPopover } from "./CloudInfoPopover";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectIcon } from "./ProjectIcon";

/** The Projects page (sidebar "Proyectos · Beta"): every project with its threads at a glance,
 *  or, before the first one, Claude's introduction with a sample conversation. */
export function ProjectsPage({
  loaded,
  recentFolders,
  onOpen,
  onCreate,
}: {
  loaded: boolean;
  /** The user's recent folders, whose GitHub remotes the dialog suggests. */
  recentFolders: string[];
  onOpen: (projectId: string) => void;
  onCreate: (input: NewProject) => Promise<unknown>;
}) {
  const t = useTranslations().projects;
  const entries = useProjectDirectory();
  const [creating, setCreating] = useState(false);
  const groupLabel = { waiting: t.groupWaiting, working: t.groupWorking, review: t.groupReview, resolved: t.groupResolved, failed: t.groupFailed };
  const empty = loaded && entries.length === 0;

  return (
    <div className="flex-1 flex flex-col overflow-y-auto custom-scrollbar bg-bg-100">
      <div className={cn("w-full max-w-[860px] mx-auto px-8 pt-14 pb-16", empty && "flex-1 flex flex-col")}>
        <div className="flex items-center mb-8">
          <h1 className="text-[28px] font-serif text-text-100">{t.navLabel}</h1>
          {entries.length > 0 && (
            <Button className={cn("ml-auto h-9 px-3.5 rounded-[8px]", DARK_BUTTON)} onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              {t.newProject}
            </Button>
          )}
        </div>

        {empty && <EmptyProjects onNew={() => setCreating(true)} />}

        {entries.length > 0 && (
          <div className="flex flex-col">
            {entries.map((e, i) => {
              const folder = projectFolder(e.project);
              const repo = e.project.repos.find((r) => r.gitUrl)?.gitUrl;
              const where = repo ? repoLabel(repo) : folder ? workspaceName(folder) : "";
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
                      <ProjectIcon className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[14px] text-text-100">{e.project.name}</span>
                        {e.dot && <span className={cn("h-2 w-2 shrink-0 rounded-full", GROUP_DOT[e.dot])} />}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 truncate text-[13px] text-text-400">
                        {where && <span className="truncate">{where}</span>}
                        {where && <span>·</span>}
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
      {creating && <NewProjectDialog recentFolders={recentFolders} onClose={() => setCreating(false)} onCreate={onCreate} />}
    </div>
  );
}

function Feature({ icon: Icon, children }: { icon: ComponentType<{ className?: string; strokeWidth?: number }>; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-[13px] leading-5 text-text-100">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-400" strokeWidth={1.75} />
      <span>{children}</span>
    </li>
  );
}

/** Before the first project: what a project is, and a sample of one, as Claude shows it. */
function EmptyProjects({ onNew }: { onNew: () => void }) {
  const t = useTranslations().projects;
  const [cloudBefore, cloudAfter = ""] = t.featCloud.split("{link}");
  return (
    <div className="flex-1 flex items-center">
      <div className="flex w-full items-center justify-between gap-10">
        <div className="max-w-[480px]">
          <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-bg-200 text-text-300">
            <ProjectIcon className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <h2 className="mt-4 text-[20px] font-medium text-text-100">{t.emptyTitle}</h2>
          <p className="mt-2 max-w-[380px] text-[13px] leading-relaxed text-text-300">{t.emptyBody}</p>
          <ul className="mt-6 flex flex-col gap-[18px]">
            <Feature icon={MessageCircle}>{t.featConversation}</Feature>
            <Feature icon={Brain}>{t.featMemory}</Feature>
            <Feature icon={Cloud}>
              {cloudBefore}
              <CloudInfoPopover>{t.featCloudLink}</CloudInfoPopover>
              {cloudAfter}
            </Feature>
            <Feature icon={Laptop}>{t.featLocal}</Feature>
          </ul>
          <Button className={cn("mt-8 h-9 px-3.5 rounded-[8px]", DARK_BUTTON)} onClick={onNew}>
            <Plus className="h-4 w-4" />
            {t.newProject}
          </Button>
        </div>
        <SampleConversation />
      </div>
    </div>
  );
}

/** The illustration: a project conversation where a task becomes a thread. */
function SampleConversation() {
  const t = useTranslations().projects;
  const bubble = "ml-auto max-w-[85%] rounded-[8px] bg-bg-100 px-3 py-2 text-[13px] leading-snug text-text-100 shadow-sm";
  return (
    <div
      aria-hidden
      // Claude's barely pink wash; a warm dark one in the dark theme.
      className="hidden lg:flex w-[320px] h-[480px] shrink-0 flex-col justify-center gap-4 rounded-[8px] p-7 bg-[linear-gradient(180deg,#fbf4f2,#fdf9f8)] dark:bg-[linear-gradient(180deg,#2f2927,#292624)]"
    >
      <p className={bubble}>{t.demoUser1}</p>
      <p className="text-[13px] leading-snug text-text-100">{t.demoReply1}</p>
      <div>
        <p className={bubble}>{t.demoUser2}</p>
        <p className="mt-1.5 flex items-center justify-end gap-1 text-[12px] text-text-400">
          <CornerDownLeft className="h-3 w-3" />
          {repliesLabel(t, 4)}
        </p>
      </div>
      <p className="text-[13px] leading-snug text-text-100">{t.demoReply2}</p>
      <div className="flex items-center gap-2.5 rounded-[8px] border border-bg-300 bg-bg-100 px-3 py-2.5">
        <span className="h-2 w-2 shrink-0 rounded-full bg-text-500" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-text-100">{t.demoThreadTitle}</span>
          <span className="block truncate text-[12px] text-text-400">{t.statusOpen}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-400" />
      </div>
    </div>
  );
}
