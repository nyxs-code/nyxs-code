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
import type { Settings } from "@/lib/settings";
import { checkCloudInbox } from "@/lib/cloud/cloudInbox";
import { createCloudThreads } from "./cloudFollow";
import { setCloudRoute } from "./cloudRoute";
import { deleteCloudCopies } from "./cloudDelete";
import { buildProjectDirectory, findThread, noteProjectRole, projectRoleOf, setProjectDirectory } from "./projectDirectory";
import { setProjectHost, type StartThreadOutcome } from "./projectHost";
import { addProjectFiles, deleteProject, ensureProjectHubDir, loadProjects, memoryPathOf, newProjectId, projectById, projectFolder, projectHubDir, projectsSnapshot, saveProject, useProjectHubs } from "./projectStore";
import { trustWorkspace } from "@/lib/globalConfig";
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
  settings: Settings;
  appRef: RefObject<ProjectAppActions | null>;
}

export interface NewProject {
  name: string;
  /** What the user wants to work on: the project's instructions. */
  instructions: string;
  /** A linked folder on this computer, for local threads. */
  folder?: string;
  /** Repository URLs (the first one is what cloud threads clone). */
  repos?: string[];
  /** Files and folders copied in as context. */
  contextPaths?: string[];
  model?: string;
  effort?: EffortLevel;
  /** Where threads run by default; from what the project has when unset. */
  where?: ThreadWhere;
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
  const checkCloudRef = useRef<() => Promise<void>>(async () => {});
  const savedRef = useRef(saved);
  useEffect(() => { savedRef.current = saved; }, [saved]);

  useEffect(() => { void loadProjects(); }, []);

  // The project folders' sessions, listed again whenever the app's list changes (a save).
  const listSeq = useRef(0);
  const relist = useCallback(() => {
    const seq = ++listSeq.current;
    // A project's sessions are in its folder, or in its own data folder when it had none.
    const folders = [...new Set(projectsSnapshot().flatMap((p) => [projectFolder(p), projectHubDir(p.id)]).filter((f): f is string => !!f))];
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
      live(id)?.workspace ?? savedRef.current.find((s) => s.id === id)?.workspace ?? findThread(id)?.workspace ?? coordinatorWorkspace(projectById(projectRoleOf(id)?.projectId)) ?? null;

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

    const patchChat = (id: string, fn: (c: Chat) => Chat) => {
      const apply = (c: Chat) => (c.id === id ? fn(c) : c);
      d().setChats((prev) => prev.map(apply));
      d().liveChatsRef.current = (d().liveChatsRef.current ?? []).map(apply);
    };
    const cloud = createCloudThreads({
      live,
      ensureLoaded,
      addChat: async (chat) => {
        d().hydratedRef.current?.add(chat.id);
        d().setChats((prev) => [chat, ...prev]);
        d().liveChatsRef.current = [chat, ...(d().liveChatsRef.current ?? [])];
        if (chat.workspace) await saveSession(chat.workspace, chat, Date.now()).catch(() => undefined);
        relist();
      },
      patchChat,
      save: async (id) => {
        const chat = live(id);
        if (chat?.workspace && d().hydratedRef.current?.has(id)) await saveSession(chat.workspace, chat, Date.now()).catch(() => undefined);
      },
      setStatus,
      deliver,
      newId: () => newSessionId([...(d().liveChatsRef.current ?? []).map((c) => c.id), ...d().sessions.map((s) => s.id), ...savedRef.current.map((s) => s.id)]),
      settings: () => d().settings,
      effectiveModel: () => d().effectiveModel,
    });
    setCloudRoute((chatId, message, text) => (cloud.isCloud(chatId) ? cloud.send(chatId, message, text) : Promise.resolve(false)));

    /** The cloud's threads now: notifications for what finished or waits while the app was
     *  closed, and their sessions caught up. Only for a user with cloud threads. */
    const sessionOfCloud = (cloudId: string) =>
      [...(d().liveChatsRef.current ?? []), ...savedRef.current].find((s) => s.threadLocation?.kind === "cloud" && s.threadLocation.cloudThreadId === cloudId)?.id;
    let checking = false;
    checkCloudRef.current = async () => {
      const any = [...(d().liveChatsRef.current ?? []), ...savedRef.current].some((s) => s.threadLocation?.kind === "cloud");
      if (!any || checking) return;
      checking = true;
      try {
        const threads = await checkCloudInbox(sessionOfCloud);
        if (threads) await cloud.sync(threads, sessionOfCloud);
      } finally {
        checking = false;
      }
    };
    const onFocus = () => void checkCloudRef.current();
    window.addEventListener("focus", onFocus);

    setProjectHost({
      startThread: async (coordinatorId, { title, instructions, model, effort, where }): Promise<StartThreadOutcome> => {
        const project = projectById(projectRoleOf(coordinatorId)?.projectId);
        const b = sessionBridge();
        if (!project || !b) return { error: "This session isn't a project's coordinator." };
        await ensureLoaded(coordinatorId);
        if ((where ?? project.defaults.where) === "cloud") {
          const out = await cloud.start(coordinatorId, project, { title, instructions, model, effort });
          if (!("error" in out)) relist();
          return out;
        }
        const folder = projectFolder(project);
        if (!folder) {
          return {
            error: project.repos.some((r) => r.gitUrl)
              ? 'This project has no folder on this computer, so its threads run in the Nyxs cloud: call it again with "where": "cloud", or ask the user to link a local folder in the project\'s settings.'
              : "This project has no folder on this computer and no repository. Ask the user to link a local folder or add a repository in the project's settings.",
          };
        }
        const parentMessageId = [...(live(coordinatorId)?.messages ?? [])].reverse().find((m) => m.role === "assistant")?.id;
        let branch: string | undefined;
        const create = (wanted: string | undefined) =>
          b.create(coordinatorId, {
            title,
            message: instructions,
            workspace: folder,
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
        return { id: out.id, model: out.model, effort: out.effort, where: "local", ...(branch ? { branch } : {}) };
      },

      stopThread: (id) => cloud.stop(id),

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
    return () => {
      setProjectHost(null);
      setCloudRoute(null);
      window.removeEventListener("focus", onFocus);
      cloud.dispose();
      checkCloudRef.current = async () => {};
    };
  }, [relist]);

  // On launch: once the projects' sessions are listed, cloud threads catch up.
  const checkedCloud = useRef(false);
  useEffect(() => {
    if (checkedCloud.current || !saved.some((s) => s.threadLocation?.kind === "cloud")) return;
    checkedCloud.current = true;
    void checkCloudRef.current();
  }, [saved]);

  /** Makes the project and its coordinator session, and opens it. */
  const createProject = useCallback(async (input: NewProject): Promise<Project> => {
    const d = ref.current;
    const id = newProjectId();
    const taken = [...(d.liveChatsRef.current ?? []).map((c) => c.id), ...d.sessions.map((s) => s.id)];
    const coordinatorChatId = newSessionId(taken);
    const urls = (input.repos ?? []).map((u) => u.trim()).filter(Boolean);
    const project: Project = {
      id,
      name: input.name.trim(),
      createdAt: Date.now(),
      repos: [...(input.folder ? [{ path: input.folder }] : []), ...urls.map((gitUrl) => ({ gitUrl }))],
      instructions: input.instructions.trim(),
      defaults: {
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        where: input.where ?? (!input.folder && urls.length ? "cloud" : "local"),
      },
      coordinatorChatId,
      memoryPath: memoryPathOf(id),
    };
    // Without a folder of its own, the coordinator works in the project's data folder, which is
    // the app's: trusted without asking.
    const hubDir = await ensureProjectHubDir(id);
    const workspace = input.folder ?? hubDir;
    if (!workspace) throw new Error("Couldn't create the project's folder.");
    if (!input.folder) await trustWorkspace(workspace).catch(() => undefined);
    await saveProject(project);
    await addProjectFiles(id, input.contextPaths ?? []).catch((e) => console.warn("[projects] couldn't copy the context files:", e));
    noteProjectRole(coordinatorChatId, id, "coordinator");
    const chat: Chat = {
      id: coordinatorChatId,
      title: project.name,
      workspace,
      messages: [],
      model: input.model ?? d.effectiveModel,
      ...(input.effort ? { effort: input.effort } : {}),
      projectId: id,
      projectRole: "coordinator",
    };
    d.hydratedRef.current?.add(chat.id);
    d.setChats((prev) => [chat, ...prev]);
    d.liveChatsRef.current = [chat, ...(d.liveChatsRef.current ?? [])];
    await saveSession(workspace, chat, Date.now()).catch(() => undefined);
    relist();
    d.appRef.current?.refreshSessions();
    d.appRef.current?.openSession(coordinatorChatId, workspace);
    return project;
  }, [relist]);

  const updateProject = useCallback(async (project: Project) => {
    await saveProject(project);
    const d = ref.current;
    const title = project.name;
    d.setChats((prev) => prev.map((c) => (c.id === project.coordinatorChatId && c.title !== title ? { ...c, title } : c)));
  }, []);

  /** Deletes the project, its coordinator and its threads. Folders and branches stay. */
  /** Deletes these sessions of `project`, their cloud threads first: when the cloud refuses,
   *  nothing is deleted and the error is thrown, for the caller to show. */
  const removeSessions = useCallback(async (project: Project, ids: Set<string>) => {
    const d = ref.current;
    const known = (id: string) => d.liveChatsRef.current?.find((c) => c.id === id) ?? savedRef.current.find((s) => s.id === id);
    const failed = await deleteCloudCopies([...ids].map((id) => known(id) ?? {}));
    if (failed) throw new Error(failed);
    for (const id of ids) d.appRef.current?.abortTurn(id);
    d.appRef.current?.dropSessions([...ids]);
    const workspaces = new Map([...ids].map((id) => [id, known(id)?.workspace ?? coordinatorWorkspace(project)]));
    d.setChats((prev) => prev.filter((c) => !ids.has(c.id)));
    for (const id of ids) await deleteSession(workspaces.get(id) ?? null, id).catch(() => undefined);
    relist();
    d.appRef.current?.refreshSessions();
  }, [relist]);

  /** Deletes the project, its coordinator and its threads, the cloud ones from the cloud too.
   *  Folders, branches and pull requests stay. */
  const removeProject = useCallback(async (projectId: string) => {
    const project = projectById(projectId);
    if (!project) return;
    const ids = new Set([project.coordinatorChatId, ...savedRef.current.filter((s) => s.projectId === projectId).map((s) => s.id)]);
    for (const c of ref.current.liveChatsRef.current ?? []) if (c.projectId === projectId) ids.add(c.id);
    await removeSessions(project, ids);
    await deleteProject(projectId);
  }, [removeSessions]);

  /** Deletes one thread (its cloud thread with it). The coordinator opens if it was on screen. */
  const removeThread = useCallback(async (threadId: string) => {
    const project = projectById(projectRoleOf(threadId)?.projectId);
    if (!project) return;
    await removeSessions(project, new Set([threadId]));
  }, [removeSessions]);

  const openProject = useCallback((projectId: string) => {
    const project = projectById(projectId);
    if (!project) return;
    const id = project.coordinatorChatId;
    const ws = ref.current.liveChatsRef.current?.find((c) => c.id === id)?.workspace ?? savedRef.current.find((s) => s.id === id)?.workspace ?? coordinatorWorkspace(project);
    ref.current.appRef.current?.openSession(id, ws);
  }, []);

  return { projects, loaded, createProject, updateProject, removeProject, removeThread, openProject };
}

/** Where a project's coordinator works when nothing else says: its folder, else its own. */
function coordinatorWorkspace(project: Project | undefined): string | null {
  return project ? projectFolder(project) ?? projectHubDir(project.id) : null;
}
