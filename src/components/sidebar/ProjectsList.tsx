import { FolderKanban } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useProjectDirectory } from "@/lib/projects/projectDirectory";
import { GROUP_DOT } from "@/lib/projects/threadStatus";

/** The sidebar's "Proyectos" section: one row per project, with a dot when something there waits
 *  on the user (amber) or works (blue). Nothing before the first project. */
export function ProjectsList({ activeProjectId, onOpen }: { activeProjectId?: string; onOpen: (projectId: string) => void }) {
  const t = useTranslations().projects;
  const entries = useProjectDirectory();
  if (!entries.length) return null;
  return (
    <div className="pb-4">
      <p className="px-2 pb-1 text-[13px] text-text-400">{t.sidebarSection}</p>
      {entries.map((e) => (
        <button
          key={e.project.id}
          type="button"
          onClick={() => onOpen(e.project.id)}
          aria-current={e.project.id === activeProjectId ? "page" : undefined}
          className={cn(
            "w-full flex items-center gap-2.5 px-2 py-1 rounded-[5px] text-sm leading-5 transition-colors",
            e.project.id === activeProjectId ? "bg-bg-200 text-text-100" : "text-text-300 hover:bg-bg-200",
          )}
        >
          <FolderKanban className="w-4 h-4 shrink-0" />
          <span className="flex-1 min-w-0 truncate text-left">{e.project.name}</span>
          {e.dot && <span className={cn("h-2 w-2 shrink-0 rounded-full", GROUP_DOT[e.dot])} />}
        </button>
      ))}
    </div>
  );
}
