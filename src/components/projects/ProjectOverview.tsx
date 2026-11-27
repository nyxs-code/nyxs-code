import { useEffect, useState } from "react";
import { Clock, ExternalLink, FilePlus, FileText, Folder, FolderPlus, GitFork, Trash2, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { getLanguage, localizedError, useTranslations } from "@/lib/i18n";
import { invoke } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/time";
import { openExternalUrl } from "@/lib/openExternal";
import { workspaceName } from "@/lib/workspace";
import { openSession } from "@/lib/sessionDirectory";
import { loadRoutines, type ScheduledTask } from "@/lib/scheduledTasks";
import type { ProjectEntry } from "@/lib/projects/projectDirectory";
import { addProjectFiles, projectFilesDir, projectFolder, removeProjectFile, useProjectFiles, useProjectMemory, writeProjectMemory } from "@/lib/projects/projectStore";
import { repoLabel } from "@/lib/projects/repoSuggestions";
import { GROUP_DOT, THREAD_GROUPS, type ThreadGroup } from "@/lib/projects/threadStatus";
import { PROJECT_MEMORY_MAX } from "@/lib/projects/types";

type Tab = "threads" | "files" | "memory" | "scheduled";

/** The project's overview, right of its conversation (340px): its threads grouped by what they
 *  need, its folders, its memory and its scheduled tasks. */
export function ProjectOverview({ entry, activeId, onOpenScheduled, onDeleteThread }: { entry: ProjectEntry; activeId: string | null; onOpenScheduled: () => void; onDeleteThread: (id: string) => void }) {
  const t = useTranslations().projects;
  const [tab, setTab] = useState<Tab>("threads");
  const tabs: { id: Tab; label: string }[] = [
    { id: "threads", label: t.tabThreads },
    { id: "files", label: t.tabFiles },
    { id: "memory", label: t.tabMemory },
    { id: "scheduled", label: t.tabScheduled },
  ];
  return (
    <aside className="w-[340px] shrink-0 flex flex-col min-h-0 border-l border-bg-300 bg-bg-0">
      <div role="tablist" aria-label={entry.project.name} className="flex items-center gap-0.5 px-2 h-11 shrink-0 border-b border-bg-300">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className={cn("h-7 px-2.5 rounded-[6px] text-[13px] transition-colors", tab === x.id ? "bg-bg-200 text-text-100" : "text-text-400 hover:text-text-100 hover:bg-bg-200/60")}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {tab === "threads" && <ThreadsTab entry={entry} activeId={activeId} onDelete={onDeleteThread} />}
        {tab === "files" && <FilesTab entry={entry} />}
        {tab === "memory" && <MemoryTab key={entry.project.id} projectId={entry.project.id} />}
        {tab === "scheduled" && <ScheduledTab folder={projectFolder(entry.project)} onOpenScheduled={onOpenScheduled} />}
      </div>
    </aside>
  );
}

function ThreadsTab({ entry, activeId, onDelete }: { entry: ProjectEntry; activeId: string | null; onDelete: (id: string) => void }) {
  const t = useTranslations().projects;
  const label: Record<ThreadGroup, string> = { waiting: t.groupWaiting, working: t.groupWorking, review: t.groupReview, resolved: t.groupResolved, failed: t.groupFailed };
  if (!entry.threads.length) return <p className="px-4 py-4 text-[13px] leading-relaxed text-text-400">{t.noThreads}</p>;
  return (
    <div className="px-2 pb-3">
      {THREAD_GROUPS.map((g) => {
        const rows = entry.threads.filter((x) => x.group === g);
        if (!rows.length) return null;
        return (
          <section key={g} aria-label={label[g]}>
            <h3 className="flex items-center gap-1.5 px-2 pt-3 pb-1 text-[12px] font-medium text-text-400">
              {label[g]}
              <span className="text-text-500">{rows.length}</span>
            </h3>
            {rows.map((x) => (
              <div key={x.id} className={cn("group relative rounded-[6px] transition-colors", x.id === activeId ? "bg-bg-200" : "hover:bg-bg-200/70")}>
                <button type="button" onClick={() => openSession(x.id)} className="w-full flex items-start gap-2.5 px-2 py-1.5 pr-9 text-left">
                  <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", GROUP_DOT[x.group])} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-text-100">{x.title}</span>
                    <span className="block truncate text-[12px] text-text-400">
                      {x.location?.kind === "cloud" ? t.cloud : t.thisComputer} · {relativeTime(x.updatedAt, getLanguage())}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`${t.deleteThread}: ${x.title}`}
                  onClick={() => onDelete(x.id)}
                  className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-[6px] text-text-400 opacity-0 hover:bg-bg-300 hover:text-text-100 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function FilesTab({ entry }: { entry: ProjectEntry }) {
  const t = useTranslations().projects;
  const id = entry.project.id;
  const files = useProjectFiles(id);
  const [error, setError] = useState("");
  const dir = projectFilesDir(id);
  const add = async (directory: boolean) => {
    const picked = await open({ multiple: true, directory }).catch(() => null);
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    setError("");
    await addProjectFiles(id, paths).catch((e) => setError(localizedError(e)));
  };
  return (
    <div className="px-2 py-3">
      <p className="px-2 pb-2 text-[12px] text-text-400">{t.filesHint}</p>
      {entry.project.repos.map((r, i) => (
        <div key={i} className="px-2 py-1.5">
          {r.path && (
            <div className="flex items-center gap-2">
              <Folder className="h-4 w-4 shrink-0 text-text-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-text-100">{workspaceName(r.path)}</span>
                <span className="block truncate text-[12px] text-text-400">{r.path}</span>
              </span>
              <Button variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => void invoke("agent_open_path", { path: r.path }).catch(() => {})}>
                {t.openFolder}
              </Button>
            </div>
          )}
          {r.gitUrl && (
            <button type="button" onClick={() => openExternalUrl(r.gitUrl!)} className="flex w-full items-center gap-2 rounded-[6px] text-left text-[13px] text-text-100 hover:text-text-200">
              <GitFork className="h-4 w-4 shrink-0 text-text-400" />
              <span className="truncate">{repoLabel(r.gitUrl)}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-text-400" />
            </button>
          )}
        </div>
      ))}

      <div className="mt-3 flex items-center gap-1 px-2 pb-1">
        <h3 className="flex-1 text-[12px] font-medium text-text-400">{t.contextFiles}</h3>
        <Button variant="ghost" icon aria-label={t.addFile} onClick={() => void add(false)}>
          <FilePlus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" icon aria-label={t.addFolder} onClick={() => void add(true)}>
          <FolderPlus className="h-4 w-4" />
        </Button>
        {dir && files.length > 0 && (
          <Button variant="ghost" icon aria-label={t.openFolder} onClick={() => void invoke("agent_open_path", { path: dir }).catch(() => {})}>
            <ExternalLink className="h-4 w-4" />
          </Button>
        )}
      </div>
      {files.length === 0 && <p className="px-2 py-1 text-[12px] leading-relaxed text-text-400">{t.noContextFiles}</p>}
      {files.map((f) => (
        <div key={f.rel} className="group flex items-center gap-2 rounded-[6px] px-2 py-1 hover:bg-bg-200/70">
          <FileText className="h-4 w-4 shrink-0 text-text-400" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-text-100">{f.rel}</span>
          <span className="shrink-0 text-[11px] text-text-500">{Math.max(1, Math.round(f.size / 1024))} KB</span>
          <button
            type="button"
            aria-label={`${t.remove}: ${f.rel}`}
            onClick={() => void removeProjectFile(id, f.rel).catch((e) => setError(localizedError(e)))}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-text-400 opacity-0 hover:bg-bg-300 hover:text-text-100 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {error && <p role="alert" className="px-2 pt-1 text-[12px] text-red-400">{error}</p>}
    </div>
  );
}

function MemoryTab({ projectId }: { projectId: string }) {
  const t = useTranslations().projects;
  const memory = useProjectMemory(projectId);
  const [draft, setDraft] = useState(memory);
  const [base, setBase] = useState(memory);
  const [saved, setSaved] = useState(false);
  // The coordinator updated it while the tab was open, and nothing was typed here.
  if (memory !== base && draft === base) {
    setBase(memory);
    setDraft(memory);
  }
  const save = async () => {
    const kept = await writeProjectMemory(projectId, draft).catch(() => null);
    if (kept === null) return;
    setBase(kept);
    setDraft(kept);
    setSaved(true);
  };
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <p className="text-[12px] leading-relaxed text-text-400">{t.memoryHint}</p>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value.slice(0, PROJECT_MEMORY_MAX));
          setSaved(false);
        }}
        placeholder={t.memoryPlaceholder}
        aria-label={t.tabMemory}
        rows={14}
        spellCheck={false}
        className="block w-full px-3 py-2 rounded-[6px] bg-bg-200 border border-transparent font-mono text-[12px] leading-relaxed text-text-100 placeholder:text-text-400 outline-none focus:border-accent resize-y"
      />
      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-[12px] text-text-400">{t.saved}</span>}
        <Button variant="secondary" disabled={draft.trim() === base.trim()} onClick={() => void save()}>{t.save}</Button>
      </div>
    </div>
  );
}

function ScheduledTab({ folder, onOpenScheduled }: { folder: string | null; onOpenScheduled: () => void }) {
  const t = useTranslations().projects;
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  useEffect(() => {
    let alive = true;
    void loadRoutines()
      .then((d) => { if (alive) setTasks(d.tasks.filter((x) => !!folder && x.workspace === folder)); })
      .catch(() => { if (alive) setTasks([]); });
    return () => { alive = false; };
  }, [folder]);
  return (
    <div className="px-2 py-3">
      <p className="px-2 pb-2 text-[12px] text-text-400">{t.scheduledHint}</p>
      {tasks && tasks.length === 0 && <p className="px-2 py-1 text-[13px] text-text-400">{t.scheduledEmpty}</p>}
      {tasks?.map((x) => (
        <div key={x.id} className="flex items-center gap-2 px-2 py-1.5">
          <Clock className={cn("h-4 w-4 shrink-0", x.enabled ? "text-text-300" : "text-text-500")} />
          <span className={cn("min-w-0 flex-1 truncate text-[13px]", x.enabled ? "text-text-100" : "text-text-400")}>{x.name}</span>
        </div>
      ))}
      <div className="px-2 pt-2">
        <Button variant="secondary" onClick={onOpenScheduled}>{t.openScheduled}</Button>
      </div>
    </div>
  );
}
