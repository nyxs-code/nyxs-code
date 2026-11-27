import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ChatMessage } from "@/components/Message";
import type { SendPayload } from "@/components/ui/claude-style-chat-input";
import type { Chat } from "@/lib/chatStore";
import { stripToolMarkers, textPayload } from "@/lib/chatMessages";
import { sessionBridge } from "@/lib/sessionBridge";
import { deleteSession, listSessions, newSessionId, patchSessionProjectFields, readSession, saveSession, type SessionSummary } from "@/lib/sessionStorage";
import { createSessionWorktree, worktreeSupported } from "@/lib/worktree";
import { worktreeBaseOf } from "@/lib/worktreeBase";
import { allowWorkspaceAccess } from "@/lib/workspace";
import { useNow } from "@/lib/useNow";
import type { EffortLevel } from "@/lib/effort";
import { buildProjectDirectory, findThread, noteProjectRole, projectRoleOf, setProjectDirectory } from "./projectDirectory";
import { setProjectHost, type StartThreadOutcome } from "./projectHost";
import { deleteProject, loadProjects, memoryPathOf, newProjectId, projectById, projectFolder, projectsSnapshot, saveProject, useProjectHubs } from "./projectStore";
import type { Project, ProjectRole, ProjectSessionFields, ThreadStatus, ThreadWhere } from "./types";

/** What the projects need from App, filled in an effect (App's handlers aren't passed during
 *  render; see the nyxs-app-structure skill). */
export interface ProjectAppActions {
  send: (payload: SendPayload, displayText?: string, chatId?: string | null) => Promise<void>;
  openSession: (id: string, workspace: string | null) => void;
  abortTurn: (chatId: string) => void;
  dropSessions: (ids: string[]) => void;
  refreshSessions: () => void;
}

interface Deps {
  chats: Chat[];
  setChats: Dispatch<SetStateAction<Chat[]>>;
  liveChatsRef: RefObject<Chat[]>;
  hydratedRef: RefObject<Set<string>>;
  ensureHydrated: (id: string) => Promise<ChatMessage[]>;
  patchMessage: (chatId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) => void;
  /** The app's sessions: a new list means sessions were saved, so the projects' are listed again. */
  sessions: SessionSummary[];
  streamingIds: ReadonlySet<string>;
  /** Chats waiting on a permission or a question. */
  blockedIds: string[];
  effectiveModel: string;
  appRef: RefObject<ProjectAppActions | null>;
}

export interface NewProject {
  name: string;
  folder: string;
  gitUrl?: string;
  instructions: string;
  model?: string;
  effort?: EffortLevel;
  where: ThreadWhere;
}

const PREVIEW_MAX = 600;
const REPORT_MAX = 6000;

const plainText = (content: string) => stripToolMarkers(content.replace(/⟦REASONING⟧[\s\S]*?⟦\/REASONING⟧/g, "")).trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Projects in the app: loads them, lists their sessions, publishes the directory the sidebar,
 *  the project page and the cards read, and runs the project tools (the ProjectHost). */
export function useProjects(deps: Deps) {
  const { projects, loaded } = useProjectHubs();
  const ref = useRef(deps);
  useEffect(() => { ref.current = deps; });
  const [saved, setSaved] = useState<SessionSummary[]>([]);
  const savedRef = useRef(saved);
  useEffect(() => { savedRef.current = saved; }, [saved]);

  useEffect(() => { void loadProjects(); }, []);

  // The project folders' sessions, listed again whenever the app's list changes (a save).
  const listSeq = useRef(0);
  const relist = useCallback(() => {
    const seq = ++listSeq.current;
    const folders = [...new Set(projectsSnapshot().map(projectFolder).filter((f): f is string => !!f))];
    void Promise.all(folders.map(async (ws) => (await listSessions(ws)).map((s) => ({ ...s, workspace: ws }))))
      .then((lists) => {
        if (seq === listSeq.current) setSaved(lists.flat().filter((s) => s.projectId));
      })
      .catch(() => undefined);
  }, []);
  useEffect(relist, [projects, deps.sessions, relist]);

  const now = useNow();
  const blockedKey = deps.blockedIds.join(" ");
  const { chats, streamingIds } = deps;
  useEffect(() => {
    const blocked = new Set(blockedKey.split(" ").filter(Boolean));
    const live = chats.filter((c) => c.projectId).map((c) => ({ ...c, modifiedAt: undefined }));
    const entries = buildProjectDirectory(projects, saved, live, streamingIds, blocked, now);
    const roles: [string, { projectId: string; role: ProjectRole }][] = [...saved, ...chats]
      .filter((s): s is typeof s & { projectId: string; projectRole: ProjectRole } => !!s.projectId && !!s.projectRole)
      .map((s) => [s.id, { projectId: s.projectId, role: s.projectRole }]);
    setProjectDirectory(entries, roles);
  }, [projects, saved, chats, streamingIds, blockedKey, now]);

  // The project tools' side in the app.
  useEffect(() => {
    const d = () => ref.current;
    const live = (id: string) => d().liveChatsRef.current?.find((c) => c.id === id);
    const app = () => d().appRef.current;
    /** Threads that reported in their running turn, with the status they reported. */
    const reported = new Map<string, ThreadStatus>();

    const workspaceOf = (id: string): string | null =>
      live(id)?.workspace ?? savedRef.current.find((s) => s.id === id)?.workspace ?? findThread(id)?.workspace ?? projectFolder(projectById(projectRoleOf(id)?.projectId)) ?? null;

    /** The session in memory, read from disk when it isn't: a coordinator the user hasn't opened
     *  since the app started still takes its threads' reports. */
    const ensureLoaded = async (id: string): Promise<boolean> => {
      if (live(id)) return true;
      const ws = workspaceOf(id);
      const read = ws ? await readSession(ws, id).catch(() => null) : null;
      if (!read || live(id)) return !!live(id);
      const chat: Chat = { ...read, workspace: ws };
      d().hydratedRef.current?.add(id);
      d().setChats((prev) => (prev.some((c) => c.id === id) ? prev : [chat, ...prev]));
      d().liveChatsRef.current = [chat, ...(d().liveChatsRef.current ?? [])];
      return true;
    };

    const setStatus = async (id: string, status: ThreadStatus, preview?: string): Promise<boolean> => {
      const patch: ProjectSessionFields = { threadStatus: status, threadUpdatedAt: Date.now(), ...(preview !== undefined ? { threadPreview: clip(preview, PREVIEW_MAX) } : {}) };
      const chat = live(id);
      if (chat) {
        const apply = (c: Chat) => (c.id === id ? { ...c, ...patch } : c);
        d().setChats((prev) => prev.map(apply));
        d().liveChatsRef.current = (d().liveChatsRef.current ?? []).map(apply);
      }
      const ws = workspaceOf(id);
      if (!ws) return !!chat;
      await patchSessionProjectFields(ws, id, patch).catch(() => undefined);
      relist();
      return true;
    };

    const deliver = async (threadId: string, text: string, status: ThreadStatus): Promise<"delivered" | "noted" | "no-coordinator"> => {
      const project = projectById(projectRoleOf(threadId)?.projectId);
      const coordinatorId = project?.coordinatorChatId;
      const b = sessionBridge();
      if (!coordinatorId || !b || !(await ensureLoaded(coordinatorId))) return "no-coordinator";
      const title = live(threadId)?.title || findThread(threadId)?.title || threadId;
      const opts = { header: `Report from the thread "${title}" (${threadId}), status ${status}:`, message: { threadReport: { status, text } } };
      const body = clip(text, REPORT_MAX);
      // A progress note goes in without waking the coordinator.
      if (status !== "working") {
        const out = await b.send(threadId, coordinatorId, body, opts);
        if (out === "sent" || out === "queued") return "delivered";
        if (out === "missing") return "no-coordinator";
      }
      const noted = await b.send(threadId, coordinatorId, body, { ...opts, quiet: true });
      return noted === "sent" ? "noted" : "no-coordinator";
    };

    setProjectHost({
      startThread: async (coordinatorId, { title, instructions, model, effort }): Promise<StartThreadOutcome> => {
        const project = projectById(projectRoleOf(coordinatorId)?.projectId);
        const b = sessionBridge();
        if (!project || !b) return { error: "This session isn't a project's coordinator." };
        await ensureLoaded(coordinatorId);
        const parentMessageId = [...(live(coordinatorId)?.messages ?? [])].reverse().find((m) => m.role === "assistant")?.id;
        let branch: string | undefined;
        const create = (wanted: string | undefined) =>
          b.create(coordinatorId, {
            title,
            message: instructions,
            model: wanted,
            effort: effort ?? project.defaults.effort,
            reportBack: false,
            prepare: async (id, workspace) => {
              noteProjectRole(id, project.id, "thread");
              let worktree: Chat["worktree"];
              try {
                if (await worktreeSupported(workspace)) {
                  worktree = await createSessionWorktree(workspace, id, undefined, worktreeBaseOf(workspace));
                  await allowWorkspaceAccess(worktree.path);
                }
              } catch (e) {
                // It works in the project folder instead; its report says so.
                console.warn("[projects] couldn't create the thread's worktree:", e);
                worktree = undefined;
              }
              branch = worktree?.branch;
              return {
                projectId: project.id,
                projectRole: "thread",
                threadStatus: "working",
                threadTitle: title,
                threadLocation: { kind: "local", workspace, ...(worktree ? { worktree: worktree.path } : {}) },
                threadUpdatedAt: Date.now(),
                ...(parentMessageId ? { parentMessageId } : {}),
                ...(worktree ? { worktree } : {}),
              };
            },
          });
        let out = await create(model ?? project.defaults.model);
        // The project's default model may be gone: the coordinator's then.
        if (typeof out === "object" && "unknownModel" in out && !model && project.defaults.model) out = await create(undefined);
        if (out === "no-project") return { error: "The project has no folder on this computer." };
        if (out === "unsupported") return { error: "This model can't run a thread from here (no key, or an agent that runs its own terminal). Ask the user which model to use." };
        if ("unknownModel" in out) return { error: `No model matches "${model}". Call it again with one of these (name or id):\n${out.unknownModel.slice(0, 40).join("\n")}` };
        if ("unknownEffort" in out) return { error: `"${effort}" isn't an effort level (${out.unknownEffort.join(", ")}).` };
        relist();
        return { id: out.id, model: out.model, effort: out.effort, ...(branch ? { branch } : {}) };
      },

      setThreadStatus: (id, status, preview) => setStatus(id, status, preview),

      report: async (threadId, text, status) => {
        reported.set(threadId, status);
        await setStatus(threadId, status, text);
        return deliver(threadId, text, status);
      },

      readThread: async (id, last) => {
        if (!(await ensureLoaded(id))) return null;
        await d().ensureHydrated(id);
        return sessionBridge()?.read(id, last) ?? null;
      },

      answerDecision: (chatId, messageId, toolId, label, question) => {
        d().patchMessage(chatId, messageId, (m) => {
          const tool = m.toolData?.[toolId];
          if (!tool?.decision) return m;
          return { ...m, toolData: { ...m.toolData, [toolId]: { ...tool, decision: { ...tool.decision, chosen: label } } } };
        });
        const model = live(chatId)?.model ?? d().effectiveModel;
        void app()?.send(textPayload(`My choice for "${question}": ${label}`, model), label, chatId);
      },

      turnEnded: (chatId, outcome) => {
        if (projectRoleOf(chatId)?.role !== "thread") return;
        const said = reported.get(chatId);
        reported.delete(chatId);
        if (said && said !== "working") return;
        void (async () => {
          // The reply's last state reaches the live list on the next render.
          await new Promise((r) => setTimeout(r, 150));
          const last = [...(live(chatId)?.messages ?? [])].reverse().find((m) => m.role === "assistant");
          const text = plainText(last?.content ?? "");
          if (outcome === "stopped") {
            await setStatus(chatId, "review", text);
            return;
          }
          const status: ThreadStatus = outcome === "error" ? "failed" : "review";
          await setStatus(chatId, status, text);
          await deliver(chatId, text || "(it ended its turn without a reply)", status);
        })().catch(() => undefined);
      },
    });
    return () => setProjectHost(null);
  }, [relist]);

  /** Makes the project and its coordinator session, and opens it. */
  const createProject = useCallback(async (input: NewProject): Promise<Project> => {
    const d = ref.current;
    const id = newProjectId();
    const taken = [...(d.liveChatsRef.current ?? []).map((c) => c.id), ...d.sessions.map((s) => s.id)];
    const coordinatorChatId = newSessionId(taken);
    const project: Project = {
      id,
      name: input.name.trim(),
      createdAt: Date.now(),
      repos: [{ path: input.folder, ...(input.gitUrl?.trim() ? { gitUrl: input.gitUrl.trim() } : {}) }],
      instructions: input.instructions,
      defaults: { ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), where: input.where },
      coordinatorChatId,
      memoryPath: memoryPathOf(id),
    };
    await saveProject(project);
    noteProjectRole(coordinatorChatId, id, "coordinator");
    const chat: Chat = {
      id: coordinatorChatId,
      title: project.name,
      workspace: input.folder,
      messages: [],
      model: input.model ?? d.effectiveModel,
      ...(input.effort ? { effort: input.effort } : {}),
      projectId: id,
      projectRole: "coordinator",
    };
    d.hydratedRef.current?.add(chat.id);
    d.setChats((prev) => [chat, ...prev]);
    d.liveChatsRef.current = [chat, ...(d.liveChatsRef.current ?? [])];
    await saveSession(input.folder, chat, Date.now()).catch(() => undefined);
    relist();
    d.appRef.current?.refreshSessions();
    d.appRef.current?.openSession(coordinatorChatId, input.folder);
    return project;
  }, [relist]);

  const updateProject = useCallback(async (project: Project) => {
    await saveProject(project);
    const d = ref.current;
    const title = project.name;
    d.setChats((prev) => prev.map((c) => (c.id === project.coordinatorChatId && c.title !== title ? { ...c, title } : c)));
  }, []);

  /** Deletes the project, its coordinator and its threads. Folders and branches stay. */
  const removeProject = useCallback(async (projectId: string) => {
    const d = ref.current;
    const project = projectById(projectId);
    if (!project) return;
    const ids = new Set([project.coordinatorChatId, ...savedRef.current.filter((s) => s.projectId === projectId).map((s) => s.id)]);
    for (const c of d.liveChatsRef.current ?? []) if (c.projectId === projectId) ids.add(c.id);
    for (const id of ids) d.appRef.current?.abortTurn(id);
    d.appRef.current?.dropSessions([...ids]);
    d.setChats((prev) => prev.filter((c) => !ids.has(c.id)));
    for (const id of ids) {
      const ws = savedRef.current.find((s) => s.id === id)?.workspace ?? d.liveChatsRef.current?.find((c) => c.id === id)?.workspace ?? projectFolder(project);
      await deleteSession(ws ?? null, id).catch(() => undefined);
    }
    await deleteProject(projectId);
    relist();
    d.appRef.current?.refreshSessions();
  }, [relist]);

  const openProject = useCallback((projectId: string) => {
    const project = projectById(projectId);
    if (project) ref.current.appRef.current?.openSession(project.coordinatorChatId, projectFolder(project));
  }, []);

  return { projects, loaded, createProject, updateProject, removeProject, openProject };
}
