import { noteVideoChatTurn } from "./video/videoControl";
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage } from "@/components/Message";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";
import { MissingKeyError, streamChat, type CacheStats, type ChatTurn } from "@/lib/ai";
import type { AskAnswer, AskQuestion } from "@/lib/agentTools";
import type { BackgroundShellEvent } from "@/lib/backgroundWake";
import { compactionBeforeReply, interruptedReply, withNextSegment, withoutEmptyReply } from "@/lib/chatMessages";
import { closeOpenTools } from "@/lib/toolMarkers";
import type { Chat, CompactionMark } from "@/lib/chatStore";
import type { EffortLevel } from "@/lib/effort";
import { getLanguage, getTranslations, localizedError } from "@/lib/i18n";
import { forgetApiTurn, rememberApiTurn } from "@/lib/interruptedTurns";
import { trackAgentWrites } from "@/lib/agentWrites";
import { contestedShellFiles, fileActivity, noteToolActivity } from "@/lib/fileActivity";
import {
  fileHistoryMakeSnapshot,
  fileHistoryRecordShellChange,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from "@/lib/fileHistory";
import { applyToolResultPruning } from "@/lib/microcompact";
import { getModel } from "@/lib/models";
import { notifyTurnDone, notifyTurnError } from "@/lib/notify";
import { startPreviewTurn } from "@/lib/previewControl";
import { createMergeCallTracker, linkOpenedPrs, createPrCallTracker, defaultBranch, fetchMergedPr, notifyPrChanged } from "@/lib/prArchive";
import { addMergedPrCard } from "@/lib/mergedPrCards";
import { createDeclaredPrScanner, createPrToolLinker, createPushCallTracker, linkDeclaredPr, notePushedBranches, publishedPrOpened } from "@/lib/prDetect";
import { linkSessionPr, parsePrUrl } from "@/lib/sessionPrLinks";
import { recallFromSession } from "@/lib/sessionRecall";
import type { Settings } from "@/lib/settings";
import { createStreamBuffer } from "@/lib/streamBuffer";
import { clearSystemPromptCache } from "@/lib/systemPrompt";
import { reportUsage } from "@/lib/telemetry";
import { setTurnAbort } from "@/lib/turnAborts";
import { releaseComputer } from "@/tools/Computer/tool";
import type { TurnInbox } from "@/lib/turnInbox";
import type { TurnSide } from "@/lib/useStreamingChats";

const uid = () => Math.random().toString(36).slice(2, 11);

/** The chat's notice for a provider that isn't set up, in the language the app is showing. */
export function missingKeyMessage(err: MissingKeyError): string {
  const t = getTranslations(getLanguage());
  const name = err.providerId === "custom" ? t.settings.customProviderName : err.providerName;
  const what = err.detail ?? t.chatUi.missingApiKey.replace("{provider}", name);
  return `${what} ${t.chatUi.fixInSettings}`;
}

export const RESUME_AFTER_RELOAD_PROMPT =
  "The Nyxs app was reloaded, restarted or closed while you were working, which cut your previous reply short (the tool calls it finished did run). Continue the task from where you left off. If you are unsure what was already done, check the current state first; don't redo finished work.";

/** One reply of the agent in a chat. */
export interface AssistantTurn {
  chatId: string;
  modelId: string;
  history: ChatTurn[];
  thinking: boolean;
  workspace: string | null;
  /** Where the session is saved, when it works elsewhere (its own worktree). */
  sessionWorkspace?: string | null;
  /** Takes a file snapshot under this id first, so the turn can be reverted. */
  snapshotId?: string;
  /** Joins a Claude Code turn already running (woken by a background task, or after a reload). */
  attachSession?: string;
  /** Where the chat's summary ended when the history was built. */
  compaction?: { upTo: number; hadSummary: boolean };
  /** The session's own effort (one an agent created with CreateSession); the app's otherwise. */
  effort?: EffortLevel;
}

/** Everything a turn reads and changes in the app. */
export interface TurnEnv {
  settings: Settings;
  /** Read when the model is called, so a change made while the snapshot is taken counts. */
  permissionMode: () => PermissionMode;
  effort: () => EffortLevel;
  setChats: Dispatch<SetStateAction<Chat[]>>;
  patchMessage: (chatId: string, msgId: string, fn: (m: ChatMessage) => ChatMessage) => void;
  /** The chat as it is right now. */
  liveChat: (chatId: string) => Chat | undefined;
  abortControllers: Map<string, AbortController>;
  /** Resolves when each chat's running turn ends. */
  turnsDone: Map<string, Promise<void>>;
  startStreaming: (chatId: string) => void;
  stopStreaming: (chatId: string) => void;
  patchTurnSide: (chatId: string, patch: TurnSide | null) => void;
  setCompacting: (chatId: string, on: boolean) => void;
  bumpRecent: (chatId: string) => void;
  gate: (chatId: string, toolName: string, input: unknown) => Promise<boolean>;
  askUser: (chatId: string, questions: AskQuestion[]) => Promise<AskAnswer[] | null>;
  clearPreapproval: (chatId: string) => void;
  cancelPrompts: (chatId: string) => void;
  fileHistory: (chatId: string) => (updater: (prev: FileHistoryState) => FileHistoryState) => void;
  queue: {
    inboxFor: (chatId: string) => TurnInbox;
    drainDelivering: (chatId: string) => { id: string }[];
    pause: (chatId: string) => void;
  };
  /** The chat messages for queued items the model received. */
  queuedAsMessages: (items: { id: string }[]) => ChatMessage[];
  /** The turn's Preview tool: `chatId` is the chat it runs in, on screen or not. */
  showPreview: (chatId: string, path: string) => void;
  /** Files changed: the diff views read them again. */
  filesChanged: () => void;
  backgroundShell: (chatId: string, event: BackgroundShellEvent) => void;
  /** The turn ended; background shells that finished meanwhile may wake the chat. */
  turnEnded: (chatId: string) => void;
  reindexRag: (workspace: string | null) => void;
  openProviderSettings: () => void;
}

/** Runs one reply: adds it to the chat, streams the model's text, tools and reasoning into it,
 *  and when it ends (done, failed or stopped) cleans up and notifies. */
export async function runAssistantTurn(turn: AssistantTurn, env: TurnEnv): Promise<void> {
  const { workspace, chatId } = turn;
  const patchChat = (fn: (c: Chat) => Chat) => env.setChats((prev) => prev.map((c) => (c.id === chatId ? fn(c) : c)));
  let assistantId = uid();
  const segmentIds = [assistantId];
  const patchReply = (fn: (m: ChatMessage) => ChatMessage) => env.patchMessage(chatId, assistantId, fn);
  patchChat((c) => ({
    ...c,
    messages: [...c.messages, { id: assistantId, role: "assistant", content: "", streaming: true, startedAt: Date.now(), createdAt: Date.now() }],
  }));

  const controller = new AbortController();
  env.abortControllers.set(chatId, controller);
  setTurnAbort(chatId, controller);
  env.startStreaming(chatId);
  startPreviewTurn(chatId);
  // Claude Code keeps working through a reload on its own (see reattachClaudeCodeRuns).
  const resumable = getModel(turn.modelId, env.settings)?.provider !== "claude-code";
  if (resumable) rememberApiTurn(chatId, turn.modelId, turn.thinking);
  let endTurn: () => void = () => {};
  const turnDone = new Promise<void>((resolve) => {
    endTurn = resolve;
  });
  env.turnsDone.set(chatId, turnDone);
  env.bumpRecent(chatId);
  env.clearPreapproval(chatId);

  if (workspace && turn.snapshotId) {
    await fileHistoryMakeSnapshot(env.fileHistory(chatId), workspace, chatId, turn.snapshotId);
  }
  // How the agent leaves each file it writes, so "Revertir" can tell when someone changed it since.
  const agentWrites = workspace && turn.snapshotId ? trackAgentWrites(chatId, workspace, turn.snapshotId, env.fileHistory(chatId)) : null;

  let turnUsage: CacheStats | null = null;
  let turnErrorBody: string | null = null;
  let turnEditedFiles = false;
  // Only a call that opened a PR (gh pr create) links the session to it.
  const prCalls = createPrCallTracker((targets) => {
    if (workspace) void linkOpenedPrs(workspace, chatId, targets, turn.sessionWorkspace ?? workspace);
  });
  // PRs the agent merged (its own or a teammate's under review) get the purple card at once,
  // from what gh printed; GitHub's answer then fills in its base branch and tells Recents, so the
  // session that opened it turns purple too.
  const confirmedMerges = new Set<string>();
  const mergeCalls = createMergeCallTracker((refs) => {
    if (!workspace) return;
    void defaultBranch(workspace).then((base) => {
      for (const ref of refs) {
        const url = ref.repo ? `https://github.com/${ref.repo}/pull/${ref.number}` : "";
        // GitHub answering first already put up the card with its real base branch.
        if (url && !confirmedMerges.has(url)) addMergedPrCard(chatId, { url, number: ref.number, base: base ?? "", mergedAt: Date.now() });
      }
    });
    for (const ref of refs) {
      void fetchMergedPr(workspace, ref).then((pr) => {
        if (!pr) return;
        confirmedMerges.add(pr.url);
        addMergedPrCard(chatId, pr);
        if (pr.head) {
          notifyPrChanged({ branch: pr.head, source: "turn", pr: { status: "merged", number: pr.number, url: pr.url, createdAt: pr.createdAt } });
        }
      });
    }
  });
  // The other ways a session opens a PR (see prDetect): a `<pr-created>` tag in the reply, a PR
  // opened on the web for a branch it pushed, a PR-opening MCP tool, Claude Code's own event.
  const prSessionWs = turn.sessionWorkspace ?? workspace;
  const linkPrUrl = (url: string, source: "tool" | "printed", branch?: string) => {
    const ref = parsePrUrl(url);
    if (ref) void linkSessionPr(prSessionWs, chatId, ref, source, branch);
  };
  const scanDeclaredPrs = createDeclaredPrScanner((url) => void linkDeclaredPr(url, [workspace, prSessionWs], prSessionWs, chatId));
  const prToolCalls = createPrToolLinker((urls) => urls.forEach((url) => linkPrUrl(url, "printed")));
  const pushCalls = workspace
    ? createPushCallTracker(workspace, (branches) => {
        const startedAt = env.liveChat(chatId)?.messages[0]?.createdAt ?? Date.now();
        notePushedBranches(chatId, prSessionWs, startedAt, branches);
      })
    : null;
  const turnFiles = new Set<string>();

  const stream = createStreamBuffer({
    content: (delta) => patchReply((m) => ({ ...m, content: m.content + delta })),
    reasoning: (deltas, reasoningTimes) =>
      patchReply((m) => {
        const rd = { ...(m.reasoningData ?? {}) };
        for (const [id, d] of Object.entries(deltas)) rd[id] = (rd[id] ?? "") + d;
        return { ...m, reasoningData: rd, reasoningTimes };
      }),
  }, Date.now, chatId);
  const baseInbox = env.queue.inboxFor(chatId);
  const inbox: TurnInbox = {
    ...baseInbox,
    // Queued messages reached the model mid-turn: the reply so far ends and a new one starts
    // after them.
    consumed: (items) => {
      baseInbox.consumed(items);
      stream.flush();
      const prevId = assistantId;
      const nextId = uid();
      const userMsgs = env.queuedAsMessages(items);
      patchChat((c) => ({ ...c, messages: withNextSegment(c.messages, prevId, userMsgs, nextId, Date.now()) }));
      for (let i = 0; i < items.length; i++) segmentIds.push(nextId);
      assistantId = nextId;
    },
  };
  // A compaction mid-turn leaves the same divider as `/compact`. Claude Code doesn't say the size
  // after it, so its divider takes the next context the turn reports.
  let compactingSince = 0;
  let awaitingAfterTokens: CompactionMark | null = null;
  const markCompaction = (tokens: { beforeTokens?: number; afterTokens?: number }) => {
    const ms = compactingSince ? Date.now() - compactingSince : 0;
    compactingSince = 0;
    const chat = env.liveChat(chatId);
    const mark =
      chat &&
      compactionBeforeReply(chat.messages, assistantId, {
        ms,
        beforeTokens: tokens.beforeTokens || chat.contextTokens || undefined,
        afterTokens: tokens.afterTokens || undefined,
      });
    if (!mark) return;
    awaitingAfterTokens = mark.afterTokens ? null : mark;
    patchChat((c) => ({ ...c, compactions: [...(c.compactions ?? []), mark] }));
  };
  const onContext = (used: number) => {
    const mark = used ? awaitingAfterTokens : null;
    if (mark) awaitingAfterTokens = null;
    patchChat((c) => ({
      ...c,
      contextTokens: used,
      ...(mark ? { compactions: c.compactions?.map((m) => (m === mark ? { ...m, afterTokens: used } : m)) } : {}),
    }));
  };
  try {
    const mode = env.permissionMode();
    noteVideoChatTurn(chatId, mode);
    await streamChat({
      modelId: turn.modelId,
      history: turn.history,
      settings: env.settings,
      onChunk: (delta) => {
        stream.content(delta);
        scanDeclaredPrs(delta);
      },
      signal: controller.signal,
      workspace,
      onTool: (id, detail) => {
        prCalls.onTool(id, detail);
        mergeCalls.onTool(id, detail);
        prToolCalls(id, detail);
        pushCalls?.(id, detail);
        noteToolActivity(fileActivity, chatId, id, detail);
        agentWrites?.tool(detail);
        patchReply((m) => ({ ...m, toolData: { ...(m.toolData ?? {}), [id]: detail } }));
      },
      onUsage: (tokens) => patchReply((m) => ({ ...m, tokens })),
      onContext,
      planMode: mode === "plan",
      permissionMode: mode,
      gate: (toolName, input) => env.gate(chatId, toolName, input),
      onTodos: (todos) => patchReply((m) => ({ ...m, todos })),
      onPlan: (plan) => patchChat((c) => ({ ...c, plan })),
      onPreview: (path) => env.showPreview(chatId, path),
      onBackgroundShell: (event) => env.backgroundShell(chatId, event),
      onShellChange: workspace && turn.snapshotId
        ? (change) => {
            turnEditedFiles = true;
            env.filesChanged();
            const contested = contestedShellFiles(fileActivity, chatId, workspace, change);
            const judged = contested.length ? { ...change, contested } : change;
            fileHistoryRecordShellChange(env.fileHistory(chatId), turn.snapshotId!, judged);
            agentWrites?.shell(judged);
          }
        : undefined,
      onFileEdit: workspace
        ? async (absPath) => {
            fileActivity.editing(chatId, absPath);
            agentWrites?.willWrite(absPath);
            turnEditedFiles = true;
            turnFiles.add(absPath);
            env.filesChanged();
            await fileHistoryTrackEdit(env.fileHistory(chatId), workspace, chatId, absPath);
          }
        : undefined,
      confirmBeforeWrite: mode === "ask",
      askUser: (questions) => env.askUser(chatId, questions),
      thinking: turn.thinking,
      onReasoning: stream.reasoning,
      onMessages: (msgs, segment) =>
        env.patchMessage(chatId, segment === undefined ? assistantId : segmentIds[segment] ?? assistantId, (m) => ({ ...m, responseMessages: msgs })),
      onCacheStats: (stats) => {
        turnUsage = stats;
        patchReply((m) => ({ ...m, usage: stats }));
      },
      onOutputLimit: (outputLimit) => patchReply((m) => ({ ...m, outputLimit })),
      // A session with an effort of its own (CreateSession set one) keeps it in every turn.
      effort: turn.effort ?? env.liveChat(chatId)?.effort ?? env.effort(),
      sessionKey: chatId,
      attachSession: turn.attachSession,
      onCompacting: (active, native) => {
        if (active) compactingSince = Date.now();
        if (native) env.patchTurnSide(chatId, { compacting: active });
        else env.setCompacting(chatId, active);
      },
      onNativeCompacted: ({ preTokens }) => markCompaction({ beforeTokens: preTokens }),
      onSubagentEdit: (edit) =>
        patchReply((m) => {
          const prev = m.subagentEdits?.[edit.path];
          return {
            ...m,
            subagentEdits: {
              ...m.subagentEdits,
              [edit.path]: { added: (prev?.added ?? 0) + edit.added, removed: (prev?.removed ?? 0) + edit.removed },
            },
          };
        }),
      onRetrying: (retry) =>
        env.patchTurnSide(chatId, {
          retrying: retry ? { rateLimited: retry.rateLimited, ...(retry.waitMs ? { at: Date.now() + retry.waitMs } : {}) } : undefined,
        }),
      onPrPublished: (change) => {
        if (publishedPrOpened(change)) linkPrUrl(change.url, "tool", change.branch);
      },
      onRemoteSetup: (host) => env.patchTurnSide(chatId, { remoteSetup: host ?? undefined }),
      recallSession: async (query, maxResults) => {
        const entries = (env.liveChat(chatId)?.messages ?? [])
          .filter((m) => m.id !== assistantId)
          .map((m, index) => ({ index, role: m.role, content: m.content, responseMessages: m.responseMessages }));
        return recallFromSession(entries, query, maxResults);
      },
      onCompacted: ({ summary, turns, beforeTokens, afterTokens }) => {
        const base = turn.compaction ?? { upTo: 0, hadSummary: false };
        const compactedUpTo = base.upTo + turns - (base.hadSummary ? 1 : 0);
        clearSystemPromptCache();
        patchChat((c) => ({ ...c, summary, compactedUpTo }));
        markCompaction({ beforeTokens, afterTokens });
      },
      onPruneToolResults: (prune) =>
        patchChat((c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.role === "assistant" && m.responseMessages?.length
              ? { ...m, responseMessages: applyToolResultPruning(m.responseMessages, prune) }
              : m,
          ),
        })),
      inbox,
    });
    stream.flush();
    // Some providers end a stopped turn by returning, not throwing: it's still a stopped turn.
    if (controller.signal.aborted) patchReply(interruptedReply);
    else patchReply((m) => ({ ...m, streaming: false }));
    if (turn.attachSession) patchChat((c) => ({ ...c, messages: withoutEmptyReply(c.messages, assistantId) }));
  } catch (err) {
    stream.flush();
    if (controller.signal.aborted) {
      patchReply(interruptedReply);
    } else {
      const msg = err instanceof MissingKeyError ? `⚠️ ${missingKeyMessage(err)}` : `⚠️ Error: ${localizedError(err)}`;
      turnErrorBody = msg;
      // After what the reply had already written too, or a failure mid-turn only shows as a
      // notification. A tool still running when it failed shows as stopped, as after a stop.
      patchReply((m) => ({ ...m, content: m.content.trim() ? `${closeOpenTools(m.content.trimEnd())}\n\n${msg}` : msg, streaming: false }));
      if (err instanceof MissingKeyError) env.openProviderSettings();
    }
  } finally {
    void agentWrites?.finish();
    fileActivity.end(chatId);
    if (resumable) forgetApiTurn(chatId);
    const undelivered = env.queuedAsMessages(env.queue.drainDelivering(chatId));
    if (undelivered.length) patchChat((c) => ({ ...c, messages: [...c.messages, ...undelivered] }));
    env.stopStreaming(chatId);
    env.patchTurnSide(chatId, null);
    env.abortControllers.delete(chatId);
    setTurnAbort(chatId, null);
    releaseComputer(chatId);
    env.clearPreapproval(chatId);
    setTimeout(() => env.turnEnded(chatId), 0);
    env.filesChanged();
    if (turnEditedFiles) env.reindexRag(workspace);
    if (turnFiles.size) {
      const changedFiles = Array.from(turnFiles);
      patchReply((m) => ({ ...m, changedFiles }));
    }
    env.cancelPrompts(chatId);
    const usage = turnUsage as CacheStats | null;
    if (!controller.signal.aborted && usage) {
      void reportUsage(turn.modelId, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
    }
    if (!controller.signal.aborted) {
      if (turnErrorBody) {
        void notifyTurnError(turnErrorBody, chatId);
        env.queue.pause(chatId);
      } else void notifyTurnDone(chatId);
    }
    // A stopped turn may have opened or merged a PR already.
    prCalls.flush();
    mergeCalls.flush();
    if (env.turnsDone.get(chatId) === turnDone) env.turnsDone.delete(chatId);
    endTurn();
  }
}
