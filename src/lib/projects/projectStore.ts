import { useSyncExternalStore } from "react";
import { invoke } from "@/lib/ipc";
import { EFFORT_LEVELS, type EffortLevel } from "@/lib/effort";
import { PROJECT_INSTRUCTIONS_MAX, PROJECT_MEMORY_MAX, type Project, type ProjectRepo } from "./types";

// The user's projects, kept by the backend in the app's data folder (agent/project_hubs.rs), and
// their memories. One store for the whole app: the sidebar, the project page, the tools and the
// system prompts all read it.

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface State {
  projects: Project[];
  loaded: boolean;
}

let state: State = { projects: [], loaded: false };
const memories = new Map<string, string>();
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A saved project as the app uses it, whatever an older or hand-edited file holds; null when
 *  it isn't one (no id or no coordinator). */
export function normalizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id).trim();
  const coordinatorChatId = str(r.coordinatorChatId).trim();
  if (!id || !coordinatorChatId) return null;
  const repos: ProjectRepo[] = (Array.isArray(r.repos) ? r.repos : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const repo: ProjectRepo = {};
      if (str(o.path).trim()) repo.path = str(o.path).trim();
      if (str(o.gitUrl).trim()) repo.gitUrl = str(o.gitUrl).trim();
      if (str(o.branch).trim()) repo.branch = str(o.branch).trim();
      return repo;
    })
    .filter((x) => x.path || x.gitUrl);
  const d = (r.defaults ?? {}) as Record<string, unknown>;
  const effort = EFFORT_LEVELS.includes(d.effort as EffortLevel) ? (d.effort as EffortLevel) : undefined;
  return {
    id,
    name: str(r.name).trim() || id,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    repos,
    instructions: str(r.instructions).slice(0, PROJECT_INSTRUCTIONS_MAX),
    defaults: {
      ...(str(d.model) ? { model: str(d.model) } : {}),
      ...(effort ? { effort } : {}),
      where: d.where === "cloud" ? "cloud" : "local",
    },
    coordinatorChatId,
    memoryPath: str(r.memoryPath) || memoryPathOf(id),
  };
}

export const memoryPathOf = (id: string) => `project-hubs/${id}/MEMORY.md`;

/** The folder a project's sessions live in and its local threads branch from: its first local
 *  folder. */
export function projectFolder(p: Pick<Project, "repos"> | undefined | null): string | null {
  return p?.repos.find((r) => r.path)?.path ?? null;
}

export function newProjectId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `p-${Date.now().toString(36)}-${rand}`;
}

export function projectsSnapshot(): Project[] {
  return state.projects;
}

export function projectById(id: string | undefined | null): Project | undefined {
  return id ? state.projects.find((p) => p.id === id) : undefined;
}

export function useProjectHubs(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const sortProjects = (list: Project[]) => [...list].sort((a, b) => b.createdAt - a.createdAt);

/** Reads every project and its memory. Kept as they were when the read fails, so a hiccup
 *  doesn't empty the sidebar. */
export async function loadProjects(): Promise<void> {
  if (!isTauri) {
    set({ loaded: true });
    return;
  }
  try {
    const { hubs, setAside } = await invoke<{ hubs: string[]; setAside: string[] }>("nyxs_project_hubs_list");
    if (setAside.length) console.warn("[projects] unreadable projects moved aside:", setAside);
    const projects: Project[] = [];
    for (const text of hubs) {
      try {
        const p = normalizeProject(JSON.parse(text));
        if (p) projects.push(p);
      } catch {
        // The backend only lists JSON objects.
      }
    }
    await Promise.all(
      projects.map(async (p) => {
        const text = await invoke<string>("nyxs_project_hub_memory_read", { id: p.id }).catch(() => null);
        if (text !== null) memories.set(p.id, text);
      }),
    );
    set({ projects: sortProjects(projects), loaded: true });
  } catch (e) {
    console.warn("[projects] couldn't list the projects:", e);
    set({ loaded: true });
  }
}

const writes = new Map<string, Promise<unknown>>();

/** One write at a time per project, in the order asked: two saves racing on the pool could
 *  leave the older one on disk. */
function queued(id: string, run: () => Promise<void>): Promise<void> {
  const next = (writes.get(id) ?? Promise.resolve()).then(run, run);
  const tail = next.catch(() => undefined);
  writes.set(id, tail);
  void tail.then(() => {
    if (writes.get(id) === tail) writes.delete(id);
  });
  return next;
}

export async function saveProject(p: Project): Promise<void> {
  const others = state.projects.filter((x) => x.id !== p.id);
  set({ projects: sortProjects([...others, p]) });
  if (!isTauri) return;
  await queued(p.id, () => invoke("nyxs_project_hubs_save", { id: p.id, json: JSON.stringify(p, null, 2) }));
}

export async function deleteProject(id: string): Promise<void> {
  set({ projects: state.projects.filter((p) => p.id !== id) });
  memories.delete(id);
  if (!isTauri) return;
  await queued(id, () => invoke("nyxs_project_hubs_delete", { id }));
}

export function projectMemory(id: string | undefined | null): string {
  return (id && memories.get(id)) || "";
}

/** Replaces the project's MEMORY.md. Returns the text kept (cut to PROJECT_MEMORY_MAX). */
export async function writeProjectMemory(id: string, text: string): Promise<string> {
  const kept = text.trim().slice(0, PROJECT_MEMORY_MAX);
  memories.set(id, kept);
  listeners.forEach((l) => l());
  if (isTauri) await queued(`${id}#memory`, () => invoke("nyxs_project_hub_memory_write", { id, text: kept ? `${kept}\n` : "" }));
  return kept;
}

/** Memories change without the project list changing: this re-renders whoever reads them. */
export function useProjectMemory(id: string | undefined | null): string {
  useProjectHubs();
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => projectMemory(id),
  );
  return projectMemory(id);
}

export function resetProjectsForTests(projects: Project[] = [], mem: Record<string, string> = {}): void {
  memories.clear();
  for (const [k, v] of Object.entries(mem)) memories.set(k, v);
  set({ projects: sortProjects(projects), loaded: true });
}
