import { useEffect, useRef, useState } from "react";
import { File, Folder, FolderSymlink, GitFork, Plus, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { pickWorkspace, workspaceName } from "@/lib/workspace";
import { repoLabel, repoUrlOf, suggestedRepos } from "@/lib/projects/repoSuggestions";
import { isProjectHubDir } from "@/lib/projects/projectStore";
import { PROJECT_INSTRUCTIONS_MAX } from "@/lib/projects/types";
import type { NewProject } from "@/lib/projects/useProjects";
import { DARK_BUTTON } from "@/lib/projects/projectUi";
import { ProjectIcon } from "./ProjectIcon";

type Item = { kind: "repo"; url: string } | { kind: "file" | "folder"; path: string } | { kind: "local"; path: string };

const ICON = { repo: GitFork, file: File, folder: Folder, local: FolderSymlink } as const;
// Fixed, under the + button: the dialog's scrolling body would cut an absolute menu off.
const MENU = "fixed z-[70] w-56 bg-bg-100 border border-bg-300 rounded-[6px] shadow-2xl p-1.5";
const MENU_ROW = "w-full flex items-center gap-2.5 px-2 py-1 rounded-[5px] text-left text-sm leading-5 text-text-100 hover:bg-bg-200";

const itemKey = (i: Item) => (i.kind === "repo" ? `repo:${i.url.toLowerCase()}` : `${i.kind}:${i.path.toLowerCase()}`);
const itemLabel = (i: Item) => (i.kind === "repo" ? repoLabel(i.url) : i.kind === "local" ? i.path : workspaceName(i.path));

/** "Nuevo proyecto", as in Claude: a name, what to work on, and context (repositories, files,
 *  folders, a local folder). Where threads run and their model live in the project's settings. */
export function NewProjectDialog({ recentFolders, onClose, onCreate }: { recentFolders: string[]; onClose: () => void; onCreate: (input: NewProject) => Promise<unknown> }) {
  const t = useTranslations().projects;
  const tm = useTranslations().modals;
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const menuOpen = menuAt !== null;
  const setMenuOpen = (open: boolean) => { if (!open) setMenuAt(null); };
  const [repoDraft, setRepoDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void suggestedRepos(recentFolders.filter((f) => !isProjectHubDir(f))).then((r) => { if (alive) setSuggested(r); }).catch(() => undefined);
    return () => { alive = false; };
  }, [recentFolders]);

  useEffect(() => {
    if (!menuOpen) return;
    const down = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [menuOpen]);

  const add = (next: Item[]) =>
    setItems((prev) => {
      // One linked local folder: a new one replaces it.
      const base = next.some((n) => n.kind === "local") ? prev.filter((p) => p.kind !== "local") : prev;
      const seen = new Set(base.map(itemKey));
      return [...base, ...next.filter((n) => !seen.has(itemKey(n)) && seen.add(itemKey(n)))];
    });
  const taken = new Set(items.map(itemKey));
  const shownSuggestions = suggested.filter((r) => !taken.has(itemKey({ kind: "repo", url: `https://github.com/${r}` })));

  const pick = async (kind: "file" | "folder" | "local" | "repo") => {
    setMenuOpen(false);
    if (kind === "repo") {
      setRepoDraft("");
      return;
    }
    if (kind === "local") {
      const path = await pickWorkspace().catch(() => null);
      if (path) add([{ kind: "local", path }]);
      return;
    }
    const picked = await open({ multiple: true, directory: kind === "folder" }).catch(() => null);
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    add(paths.map((path) => ({ kind, path })));
  };

  const addRepo = () => {
    const url = repoUrlOf(repoDraft ?? "");
    if (!url) return;
    add([{ kind: "repo", url }]);
    setRepoDraft(null);
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({
        name: name.trim(),
        instructions: goal,
        folder: items.find((i): i is Extract<Item, { kind: "local" }> => i.kind === "local")?.path,
        repos: items.flatMap((i) => (i.kind === "repo" ? [i.url] : [])),
        contextPaths: items.flatMap((i) => (i.kind === "file" || i.kind === "folder" ? [i.path] : [])),
      });
      onClose();
    } catch (e) {
      console.warn("[projects] creating failed:", e);
      setError(t.createFailed);
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} initialFocus={nameRef} className="max-w-[465px] max-h-[min(720px,100%)] overflow-hidden flex flex-col">
      <DialogHeader className="px-5 pt-4 pb-1">
        <DialogTitle className="text-[14px] font-semibold">{t.createTitle}</DialogTitle>
      </DialogHeader>
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 pt-2 pb-4">
        <label htmlFor="new-project-name" className="block text-[13px] text-text-200 mb-1.5">{t.nameLabel}</label>
        <div className="flex items-center gap-2 rounded-[8px] border border-bg-300 bg-bg-100 px-1.5 py-1.5 focus-within:border-accent">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-bg-200 text-text-300">
            <ProjectIcon className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <input
            id="new-project-name"
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void create(); }}
            placeholder={t.namePlaceholder}
            maxLength={80}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-text-100 placeholder:text-text-400 outline-none"
          />
        </div>

        <label htmlFor="new-project-goal" className="mt-4 block text-[13px] text-text-200 mb-1.5">
          {t.goalLabel} <span className="text-text-400">{t.optional}</span>
        </label>
        <textarea
          id="new-project-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value.slice(0, PROJECT_INSTRUCTIONS_MAX))}
          placeholder={t.goalPlaceholder}
          className="block h-[70px] w-full resize-none rounded-[8px] border border-transparent bg-bg-200 px-3 py-2 text-[14px] text-text-100 placeholder:text-text-400 outline-none focus:border-accent"
        />

        <div className="mt-4 rounded-[8px] border border-bg-300">
          <div className="flex items-center px-3 pt-2.5 pb-1">
            <span className="flex-1 text-[13px] text-text-200">
              {t.contextLabel} <span className="text-text-400">{t.optional}</span>
            </span>
            <div
              ref={menuRef}
              className="relative"
              // Escape closes the menu only, not the dialog with what was typed in it.
              onKeyDown={(e) => {
                if (e.key !== "Escape" || !menuOpen) return;
                e.stopPropagation();
                setMenuOpen(false);
              }}
            >
              <Button variant="ghost" icon aria-label={t.addContext} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(e) => {
                if (menuOpen) return setMenuOpen(false);
                const r = e.currentTarget.getBoundingClientRect();
                setMenuAt({ top: r.bottom + 4, right: window.innerWidth - r.right });
              }}>
                <Plus className="h-4 w-4" />
              </Button>
              {menuOpen && (
                <div role="menu" className={MENU} style={{ top: menuAt.top, right: menuAt.right }}>
                  {([["repo", t.addRepo], ["file", t.addFile], ["folder", t.addFolder], ["local", t.linkFolder]] as const).map(([kind, label]) => {
                    const Icon = ICON[kind];
                    return (
                      <button key={kind} role="menuitem" type="button" onClick={() => void pick(kind)} className={MENU_ROW}>
                        <Icon className="h-4 w-4 shrink-0 text-text-300" />
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="px-3 pb-2">
            {repoDraft !== null && (
              <div className="flex items-center gap-2 py-1.5">
                <GitFork className="h-4 w-4 shrink-0 text-text-400" />
                <input
                  autoFocus
                  value={repoDraft}
                  onChange={(e) => setRepoDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addRepo();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setRepoDraft(null);
                    }
                  }}
                  placeholder={t.repoInputPlaceholder}
                  aria-label={t.addRepo}
                  spellCheck={false}
                  className="min-w-0 flex-1 h-7 rounded-[6px] bg-bg-200 px-2 text-[13px] text-text-100 placeholder:text-text-400 outline-none border border-transparent focus:border-accent"
                />
                <Button variant="secondary" disabled={!repoUrlOf(repoDraft)} onClick={addRepo}>{t.add}</Button>
              </div>
            )}
            {items.map((i) => {
              const Icon = ICON[i.kind];
              return (
                <div key={itemKey(i)} className="flex items-center gap-2 border-b border-bg-300 py-1.5 last:border-b-0">
                  <Icon className="h-4 w-4 shrink-0 text-text-400" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-100">{itemLabel(i)}</span>
                  <button
                    type="button"
                    aria-label={`${t.remove}: ${itemLabel(i)}`}
                    onClick={() => setItems((prev) => prev.filter((x) => itemKey(x) !== itemKey(i)))}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-text-400 hover:bg-bg-200 hover:text-text-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            {shownSuggestions.length > 0 && (
              <>
                <p className={cn("pb-1 text-[12px] text-text-400", items.length > 0 || repoDraft !== null ? "pt-2.5" : "pt-0.5")}>{t.suggested}</p>
                {shownSuggestions.map((r, idx) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => add([{ kind: "repo", url: `https://github.com/${r}` }])}
                    className={cn("flex w-full items-center gap-2 py-1.5 text-left text-[13px] text-text-200 hover:text-text-100", idx < shownSuggestions.length - 1 && "border-b border-bg-300")}
                  >
                    <Plus className="h-4 w-4 shrink-0 text-text-400" />
                    <span className="truncate">{r}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
        {error && <p role="alert" className="mt-3 text-[13px] text-red-400">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 px-5 pb-4 pt-1">
        <Button variant="ghost" className="bg-bg-200 text-text-100 hover:bg-bg-300" onClick={onClose}>{tm.cancel}</Button>
        <Button className={DARK_BUTTON} disabled={!name.trim() || busy} onClick={() => void create()}>{t.create}</Button>
      </div>
    </Dialog>
  );
}
