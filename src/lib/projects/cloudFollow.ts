import type { ChatMessage } from "@/components/Message";
import type { Chat } from "@/lib/chatStore";
import { getActiveModels, getModel } from "@/lib/models";
import type { Settings } from "@/lib/settings";
import { resolveEffort, resolveSessionModel } from "@/lib/sessionModels";
import { attributedMessage } from "@/lib/sessionBridge";
import { cloudThreadEvents, createCloudThread, followCloudThread, sendCloudMessage, stopCloudThread, CloudError, type CloudThread } from "@/lib/cloud/cloudApi";
import { cloudSupport, sanitizedCloudSettings } from "@/lib/cloud/cloudCredentials";
import { applyCloudEvents, threadStatusOfCloud, type CloudEffect } from "./cloudThreads";
import { noteProjectRole } from "./projectDirectory";
import type { StartThreadOutcome, StartThreadRequest } from "./projectHost";
import { projectFolder, projectMemory } from "./projectStore";
import { filesSection } from "./projectPrompt";
import type { Project, ThreadStatus } from "./types";

/** What the cloud threads need from the projects hook, which holds the chats. */
export interface CloudHelpers {
  live: (id: string) => Chat | undefined;
  ensureLoaded: (id: string) => Promise<boolean>;
  /** Adds a new session to the app (memory, Recents' list, disk). */
  addChat: (chat: Chat) => Promise<void>;
  patchChat: (id: string, fn: (c: Chat) => Chat) => void;
  save: (id: string) => Promise<void>;
  setStatus: (id: string, status: ThreadStatus, preview?: string) => Promise<boolean>;
  /** The thread's report as a card in the coordinator conversation. */
  deliver: (threadId: string, text: string, status: ThreadStatus) => Promise<unknown>;
  newId: () => string;
  settings: () => Settings;
  effectiveModel: () => string;
}

const cloudIdOf = (c: Chat | undefined) => (c?.threadLocation?.kind === "cloud" ? c.threadLocation.cloudThreadId : undefined);

const failureText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The project's cloud threads while the app runs: starting one, following its events into its
 *  session, sending it the user's messages, stopping it, and catching up on launch. */
export function createCloudThreads(h: CloudHelpers) {
  const following = new Map<string, AbortController>();
  /** Threads whose turn already reported a final status: its `done` doesn't report again. */
  const reportedTurn = new Set<string>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const saveSoon = (id: string) => {
    clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(() => { saveTimers.delete(id); void h.save(id); }, 600));
  };

  const run = async (id: string, effect: CloudEffect) => {
    if (effect.kind === "status") {
      await h.setStatus(id, effect.status);
      return;
    }
    if (effect.kind === "report") {
      if (effect.status !== "working") reportedTurn.add(id);
      await h.setStatus(id, effect.status, effect.text);
      await h.deliver(id, effect.text, effect.status);
      return;
    }
    h.patchChat(id, (c) => ({
      ...c,
      ...(effect.prUrl ? { threadPrUrl: effect.prUrl } : {}),
      ...(effect.branch && c.threadLocation?.kind === "cloud" ? { threadLocation: { ...c.threadLocation, branch: effect.branch } } : {}),
    }));
    await h.setStatus(id, effect.status, effect.preview);
    const said = reportedTurn.delete(id);
    const pr = effect.prUrl ? `\n\nPull request: ${effect.prUrl}` : "";
    const failed = effect.error ? `> ${effect.error.replace(/\n/g, "\n> ")}` : "";
    // A thread that reported already says nothing more, unless publishing its work failed.
    if (!said) await h.deliver(id, `${effect.preview || "(it ended its turn without a reply)"}${failed ? `\n\n${failed}` : ""}${pr}`, effect.status);
    else if (failed) await h.deliver(id, failed, effect.status);
    await h.save(id);
  };

  /** Follows the thread's events from the last one in its transcript until its turn is done.
   *  `once`: only what is there already (a thread that isn't running), without waiting. */
  const follow = (id: string, once = false) => {
    if (following.has(id)) return;
    const cloudId = cloudIdOf(h.live(id));
    if (!cloudId) return;
    const ctrl = new AbortController();
    following.set(id, ctrl);
    // One event at a time, in order, each effect done before the next.
    let chain = Promise.resolve();
    const onEvent = (ev: Parameters<Parameters<typeof followCloudThread>[2]>[0]) => {
      chain = chain.then(async () => {
        const chat = h.live(id);
        // Stopped: what was still on its way doesn't overwrite the stop.
        if (!chat || ctrl.signal.aborted) return;
        const out = applyCloudEvents(chat.messages, [ev], chat.threadCloudSeq ?? 0, (seq) => `cloud-${cloudId}-${seq}`);
        if (out.seq === (chat.threadCloudSeq ?? 0)) return;
        h.patchChat(id, (c) => ({ ...c, messages: out.messages, threadCloudSeq: out.seq }));
        for (const e of out.effects) await run(id, e);
        saveSoon(id);
      }).catch((e) => console.warn("[projects] cloud event failed:", e));
    };
    void (async () => {
      try {
        await h.ensureLoaded(id);
        const after = h.live(id)?.threadCloudSeq ?? 0;
        // A long poll on a thread with nothing more to come would wait for ever.
        if (once) (await cloudThreadEvents(cloudId, after, 0, ctrl.signal)).forEach(onEvent);
        else await followCloudThread(cloudId, after, onEvent, ctrl.signal);
      } catch (e) {
        if (e instanceof CloudError && e.status === 404) await h.setStatus(id, "failed", failureText(e));
      } finally {
        await chain;
        if (following.get(id) === ctrl) following.delete(id);
      }
    })();
  };

  /** A user's or the coordinator's message to a cloud thread: shown in it and queued there. */
  const send = async (id: string, message: ChatMessage, text: string): Promise<boolean> => {
    const cloudId = cloudIdOf(h.live(id));
    if (!cloudId) return false;
    // Marked until its `user` event comes back, so the transcript shows it once.
    h.patchChat(id, (c) => ({ ...c, messages: [...c.messages, { ...message, cloudPending: true }] }));
    try {
      await sendCloudMessage(cloudId, text);
      await h.setStatus(id, "working");
      follow(id);
    } catch (e) {
      // Never reached the cloud: no `user` event will clear it.
      h.patchChat(id, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === message.id ? { ...m, cloudPending: undefined } : m)) }));
      const note: ChatMessage = { id: `cloud-error-${Date.now()}`, role: "assistant", content: `> ${failureText(e)}`, createdAt: Date.now() };
      h.patchChat(id, (c) => ({ ...c, messages: [...c.messages, note] }));
    }
    await h.save(id);
    return true;
  };

  const stop = async (id: string): Promise<boolean> => {
    const cloudId = cloudIdOf(h.live(id));
    if (!cloudId) return false;
    await stopCloudThread(cloudId);
    following.get(id)?.abort();
    await h.setStatus(id, "idle");
    return true;
  };

  /** Opens a thread in the Nyxs cloud for the coordinator `coordinatorId`. */
  const start = async (coordinatorId: string, project: Project, req: StartThreadRequest): Promise<StartThreadOutcome> => {
    const repo = project.repos.find((r) => r.gitUrl);
    if (!repo?.gitUrl) return { error: 'A cloud thread clones the project\'s repository, and this project has no repository URL. Ask the user to add it in the project\'s settings, or call it again with "where": "local".' };
    const folder = projectFolder(project) ?? h.live(coordinatorId)?.workspace;
    if (!folder) return { error: "The project has no folder on this computer to keep the thread's conversation in." };
    const settings = h.settings();
    const models = getActiveModels(settings);
    const wanted = req.model ?? project.defaults.model ?? h.live(coordinatorId)?.model ?? h.effectiveModel();
    const model = req.model ? resolveSessionModel(req.model, models) : (getModel(wanted, settings) ?? resolveSessionModel(wanted, models));
    if (!model) return { error: `No model matches "${wanted}". Call it again with one of these (name or id):\n${models.slice(0, 40).map((m) => `${m.name} (${m.id})`).join("\n")}` };
    const support = cloudSupport(model.provider, settings);
    if (!support.ok) {
      return {
        error:
          support.reason === "local"
            ? `${model.name} runs on this computer's network, which the Nyxs cloud can't reach. Pick another model or run the thread here ("where": "local").`
            : `${model.name}'s agent isn't available in the Nyxs cloud yet (only Claude Code and Codex are). Pick another model or run the thread here ("where": "local").`,
      };
    }
    const effort = (req.effort ? resolveEffort(req.effort) : undefined) ?? project.defaults.effort ?? h.live(coordinatorId)?.effort;
    let created: { id: string };
    try {
      created = await createCloudThread({
        projectId: project.id,
        title: req.title,
        instructions: req.instructions,
        repo: { url: repo.gitUrl, ...(repo.branch ? { branch: repo.branch } : {}) },
        model: { id: model.id, provider: model.provider, ...(effort ? { effort } : {}) },
        settings: sanitizedCloudSettings(settings),
        // The container can't reach this computer's copies: the context files go as text.
        projectInstructions: [project.instructions, filesSection(project, null)].filter((s) => s.trim()).join("\n\n"),
        memory: projectMemory(project.id),
      });
    } catch (e) {
      if (e instanceof CloudError && (e.code === "not_allowed" || e.status === 403)) {
        return { error: 'La nube está en beta privada: the Nyxs cloud is in a private beta and this account isn\'t in it yet. Tell the user so, and run the thread on this computer ("where": "local") if they want.' };
      }
      if (e instanceof CloudError && e.status === 401) return { error: "The user isn't signed in to Nyxs, which the cloud needs. Ask them to sign in, or run the thread on this computer." };
      return { error: `The Nyxs cloud didn't take the thread: ${failureText(e)}` };
    }
    const id = h.newId();
    noteProjectRole(id, project.id, "thread");
    const coordinator = h.live(coordinatorId);
    const parentMessageId = [...(coordinator?.messages ?? [])].reverse().find((m) => m.role === "assistant")?.id;
    const from = coordinator?.title ?? project.name;
    const first: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: attributedMessage(`Message from the session "${from}" (${coordinatorId}), which created this one:`, req.instructions),
      createdAt: Date.now(),
      fromSession: { id: coordinatorId, title: from },
      cloudPending: true,
    };
    await h.addChat({
      id,
      title: req.title,
      workspace: folder,
      messages: [first],
      model: model.id,
      ...(effort ? { effort } : {}),
      parentId: coordinatorId,
      projectId: project.id,
      projectRole: "thread",
      threadStatus: "working",
      threadTitle: req.title,
      threadLocation: { kind: "cloud", cloudThreadId: created.id },
      threadUpdatedAt: Date.now(),
      threadCloudSeq: 0,
      ...(parentMessageId ? { parentMessageId } : {}),
    });
    follow(id);
    return { id, model: model.name, effort: effort ?? "default", where: "cloud" };
  };

  /** What the cloud says now (the launch check, the window coming back): statuses that changed
   *  while the app was closed, and the events of every thread that moved, followed. */
  const sync = async (threads: CloudThread[], sessionOf: (cloudId: string) => string | undefined) => {
    for (const t of threads) {
      const id = sessionOf(t.id);
      if (!id || following.has(id)) continue;
      const running = t.status === "queued" || t.status === "working";
      const status = threadStatusOfCloud(t.status);
      const known = h.live(id);
      // A thread nothing happened to isn't read from disk.
      if (!running && known && status === known.threadStatus && Date.parse(t.updatedAt) <= (known.threadUpdatedAt ?? 0)) continue;
      if (!(await h.ensureLoaded(id))) continue;
      const chat = h.live(id);
      const moved = status !== chat?.threadStatus || Date.parse(t.updatedAt) > (chat?.threadUpdatedAt ?? 0);
      if (running || moved) follow(id, !running);
    }
  };

  const dispose = () => {
    for (const c of following.values()) c.abort();
    following.clear();
    for (const t of saveTimers.values()) clearTimeout(t);
    saveTimers.clear();
  };

  return { start, follow, send, stop, sync, dispose, isCloud: (id: string) => !!cloudIdOf(h.live(id)) };
}
