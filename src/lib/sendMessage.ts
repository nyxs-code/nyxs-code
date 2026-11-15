import { releasePreviews } from "@/lib/attachmentPreviews";
import type { Dispatch, SetStateAction } from "react";
import type { PermissionMode, SendPayload } from "@/components/ui/claude-style-chat-input";
import type { ChatTurn } from "@/lib/ai";
import type { AssistantTurn } from "@/lib/assistantTurn";
import type { ChatHistory } from "@/lib/chatHistory";
import type { Chat } from "@/lib/chatStore";
import { matchCommand, resolveCommandContent, type CommandDef } from "@/lib/commands";
import { pendingEnvironment, registerSessionEnvironment, savedEnvironments } from "@/lib/environments";
import { getModel } from "@/lib/models";
import { outgoingMessage } from "@/lib/outgoingMessage";
import { renameSession, saveSession } from "@/lib/sessionStorage";
import { hasKey, type Settings } from "@/lib/settings";
import { sessionWorktreeOn } from "@/lib/sessionWorktree";
import { matchBuiltinPromptCommand, parseBuiltinCommand, resolvePromptCommand } from "@/lib/slashCommand";
import { clampTitle, generateChatTitle } from "@/lib/titles";
import { generateUniqueWordSlug } from "@/lib/words";

export const newChatId = (chats: Chat[]) => generateUniqueWordSlug(new Set(chats.map((c) => c.id)));

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Everything sending a message reads and changes in the app; built when it's sent. */
export interface SendEnv {
  /** The open chat: where a message goes when the caller names no chat. */
  activeId: string | null;
  workspace: string | null;
  settings: Settings;
  chats: Chat[];
  /** The model a new chat records as its own. */
  effectiveModel: string;
  permissionMode: () => PermissionMode;
  /** The folder's `/` commands from files. */
  fileCommands: () => CommandDef[];
  runBuiltin: (name: string, args: string, chatId: string | null) => Promise<void>;
  /** Sends again with the app as it is by then (an expanded command, or after a folder was
   *  opened). Without `chatId`, to the chat open at that point. */
  resend: (payload: SendPayload, displayText?: string, chatId?: string | null) => Promise<void> | undefined;
  /** Asks to open a project folder; the folder opened, or null if the user didn't. */
  askForWorkspace: () => Promise<string | null>;
  /** Puts a message the app didn't send back in the chat box, attachments and all. */
  refillInput: (payload: SendPayload) => void;
  openProviderSettings: () => void;
  /** The worktree a new session starts in: undefined for none, null when the user gave up. */
  startSessionWorktree: (workspace: string, chatId: string) => Promise<Chat["worktree"] | null>;
  buildChatHistory: (chatId: string) => Promise<Pick<ChatHistory, "history" | "compaction">>;
  workDirOfChat: (chatId: string) => string | null;
  setChats: Dispatch<SetStateAction<Chat[]>>;
  /** Adds a new chat and opens it. */
  openNewChat: (chat: Chat) => void;
  refreshSessions: () => void;
  streamTurn: (turn: AssistantTurn) => Promise<void>;
  /** Runs `text` when it is a mod's `/` command in that chat's session; false when it isn't one. */
  runModCommand?: (text: string, chatId: string | null) => Promise<boolean>;
  /** The session's mods see a prompt first (`prompt.submit`): it goes on rewritten, or is dropped. */
  modPrompt?: (text: string, chatId: string | null) => Promise<{ text: string } | { drop: string }>;
  /** Told to the model once, with the next message: what became of the mods it wrote. */
  modNotice?: (chatId: string) => string | null;
  /** A new chat was made for this message: a new session's mods go on under its id. */
  chatCreated?: (chatId: string) => void;
}

/** Sends what the chat box (or the app) sends: runs a built-in command, expands a `/` command,
 *  or starts a reply, in a new chat when there is none. `chatId` (default: the open chat) is
 *  where it goes, so a message sent from the queue after the user switched chats still lands
 *  in the chat it was queued in. */
export async function sendMessage(
  payload: SendPayload,
  displayText: string | undefined,
  env: SendEnv,
  chatId: string | null = env.activeId,
): Promise<void> {
  const text = payload.message.trim();
  const { workspace, settings } = env;
  if (!displayText) {
    const builtin = parseBuiltinCommand(text);
    if (builtin) {
      await env.runBuiltin(builtin.name, builtin.args, chatId);
      return;
    }
    const promptCmd = matchBuiltinPromptCommand(text);
    if (promptCmd) {
      const expanded = resolvePromptCommand(promptCmd.cmd, promptCmd.args);
      await nextTick();
      return env.resend({ ...payload, message: expanded }, text, chatId);
    }
    if (await env.runModCommand?.(text, chatId)) return;
    const matched = matchCommand(text, env.fileCommands());
    if (matched) {
      const expanded = resolveCommandContent(matched.cmd, matched.args);
      const model = matched.cmd.model && getModel(matched.cmd.model, settings) ? matched.cmd.model : payload.model;
      await nextTick();
      return env.resend({ ...payload, message: expanded, model }, text, chatId);
    }
  }
  if (!workspace) {
    const picked = await env.askForWorkspace();
    if (!picked) {
      if (!displayText) env.refillInput(payload);
      return;
    }
    await nextTick();
    // Opening a folder can change the open chat; the message follows it.
    return env.resend(payload, displayText);
  }
  // A message the app expanded from a command is past the mods: they saw the command.
  if (!displayText && env.modPrompt) {
    const seen = await env.modPrompt(payload.message, chatId);
    if ("drop" in seen) {
      env.refillInput(payload);
      return;
    }
    if (seen.text !== payload.message) payload = { ...payload, message: seen.text };
  }
  const out = await outgoingMessage(payload, displayText);
  if (!out) return;
  const { userMessage: userMsg, modelImages, titleText } = out;
  let { modelText } = out;

  // A model no longer on offer (an old chat's, Apply plan's) gives way to the one in use, instead of
  // nothing happening at all.
  const modelId = getModel(payload.model, settings) ? payload.model : env.effectiveModel;
  const model = getModel(modelId, settings);
  // Not sent: what the user wrote goes back to the chat box instead of being lost.
  if (!model) {
    if (!displayText) env.refillInput(payload);
    return;
  }
  if (!hasKey(settings, model.provider)) {
    if (!displayText) env.refillInput(payload);
    env.openProviderSettings();
    return;
  }

  const history: ChatTurn[] = [];
  let compaction: { upTo: number; hadSummary: boolean } = { upTo: 0, hadSummary: false };
  let turnDir: string = workspace;
  if (!chatId) {
    chatId = newChatId(env.chats);
    // The composer's Worktree switch: the session gets its own copy of the project.
    const worktree = sessionWorktreeOn() ? await env.startSessionWorktree(workspace, chatId) : undefined;
    if (worktree === null) {
      if (!displayText) env.refillInput(payload);
      return;
    }
    if (worktree) turnDir = worktree.path;
    // Started from a saved environment (picked in the composer for this folder): its turns get
    // that environment's variables.
    const envId = pendingEnvironment();
    const environmentId = envId && savedEnvironments().some((e) => e.id === envId && e.folder === workspace) ? envId : undefined;
    if (environmentId) registerSessionEnvironment(chatId, environmentId);
    const chat: Chat = { id: chatId, title: clampTitle(titleText, 35) || "Imagen", workspace, messages: [userMsg], model: env.effectiveModel, permissionMode: env.permissionMode(), worktree, environmentId };
    env.chatCreated?.(chatId);
    env.openNewChat(chat);
    void saveSession(workspace, chat, Date.now()).then(env.refreshSessions);
    const titleChatId = chatId;
    void generateChatTitle(titleText, undefined, model.provider).then((title) => {
      if (!title) return;
      env.setChats((prev) => prev.map((c) => (c.id === titleChatId ? { ...c, title } : c)));
      void renameSession(workspace, titleChatId, title).then(env.refreshSessions);
    });
  } else {
    turnDir = env.workDirOfChat(chatId) ?? workspace;
    const built = await env.buildChatHistory(chatId);
    history.push(...built.history);
    compaction = built.compaction;
    const target = chatId;
    env.setChats((prev) => prev.map((c) => (c.id === target ? { ...c, messages: [...c.messages, userMsg] } : c)));
  }
  const notice = env.modNotice?.(chatId);
  if (notice) modelText = `${modelText}

<system-reminder>
${notice}
</system-reminder>`;
  history.push({ role: "user", content: modelText, images: modelImages });

  // The message is on its way: nothing gives it back to the chat box after this, and the chat shows
  // its images from their data, so the composer's thumbnails can go.
  releasePreviews(payload.files);
  await env.streamTurn({ chatId, modelId, history, thinking: payload.isThinkingEnabled, workspace: turnDir, sessionWorkspace: workspace, snapshotId: userMsg.id, compaction });
}
