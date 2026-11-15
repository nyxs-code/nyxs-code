import type { ViewId } from "@/components/ViewsPanel";
import type { PermissionMode, SendPayload } from "@/components/ui/claude-style-chat-input";
import type { Chat, CompactionMark } from "@/lib/chatStore";
import { stripToolMarkers, textPayload } from "@/lib/chatMessages";
import type { CompactRun } from "@/lib/compactAborts";
import { compactChat } from "@/lib/compactChat";
import { closeClaudeCodeChat } from "@/lib/claudeCode";
import { openSideChat } from "@/lib/sideChat";
import { openCliResume } from "@/lib/cliSessions";
import type { EffortLevel } from "@/lib/effort";
import {
  buildDoctorReport,
  buildMcpReport,
  buildSkillsReport,
  buildStatusReport,
  formatMcpText,
  formatSkillsText,
  formatStatusText,
  toJsonBlock,
} from "@/lib/reports";
import type { Settings } from "@/lib/settings";
import { clearSystemPromptCache } from "@/lib/systemPrompt";

/** `/verify`, with the approved plan from the chat: no plan file is kept in the project to read. */
const verifyPlanPrompt = (plan: string) =>
  "Verify that the work done matches the approved plan below. Inspect the actual state of the relevant files. Do NOT modify, create, or delete any files — this is a read-only verification. " +
  "For EACH concrete step or item in the plan, report its status as one of: ✅ done (implemented as planned), ⚠️ partial (started but incomplete or deviating), or ❌ missing (not done). Give a one-line justification for each, citing the file path(s) you checked. " +
  "Finish with (1) an overall verdict — does the implementation faithfully match the approved plan? — and (2) a concise bullet list of any gaps, deviations, or follow-ups. Be specific and honest; surface anything that diverges from the plan rather than glossing over it. Reply in the user's language." +
  `\n\n<plan>\n${plan.trim()}\n</plan>`;

/** What a built-in command can read and do in the app. */
export interface BuiltinContext {
  /** The open chat, if any. */
  chat: Chat | undefined;
  /** The model in use, and the one picked in the chat box (they differ when the picked one
   *  is no longer available). */
  modelId: string;
  selectedModelId: string;
  settings: Settings;
  workspace: string | null;
  permissionMode: PermissionMode;
  allowPermissionBypass: boolean;
  effort: EffortLevel;
  /** `/compact`'s own signal: it runs outside a turn, and stopping the chat (Esc, the stop
   *  button) aborts it like one. */
  startCompact: (chatId: string) => CompactRun;
  /** Shows a message from Nyxs in the open chat (a new one if none is open). */
  reply: (content: string) => void;
  send: (payload: SendPayload, displayText?: string) => void;
  patchChat: (chatId: string, patch: Partial<Chat>) => void;
  /** Marks the chat being summarised, so only that chat shows the notice. */
  setCompacting: (chatId: string, on: boolean) => void;
  newChat: () => void;
  openDialog: (dialog: "help" | "shortcuts" | "models" | "doctor") => void;
  openSettings: (section?: string) => void;
  openView: (view: ViewId) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  /** Asks to turn on skipping permissions, which leaving plan mode needs when it is off. */
  promptEnableBypass: () => void;
}

const VIEW_COMMANDS: Record<string, ViewId> = {
  terminal: "terminal",
  files: "files",
  tasks: "background",
  preview: "preview",
  diff: "diff",
};

/** Runs a built-in `/` command (`/help`, `/compact`, `/status`…). `args` is what followed the
 *  name; `json` makes the report commands answer with JSON. */
export async function runBuiltinCommand(name: string, args: string, ctx: BuiltinContext): Promise<void> {
  const wantsJson = args.trim().toLowerCase() === "json";
  const { chat } = ctx;
  if (name in VIEW_COMMANDS) {
    ctx.openView(VIEW_COMMANDS[name]);
    return;
  }
  switch (name) {
    case "resume":
      // Claude Code sessions from the terminal or the Claude app, to continue here.
      openCliResume();
      return;
    case "btw":
      // A side question: answered apart, nothing added to this chat.
      openSideChat(args);
      return;
    case "help":
      ctx.openDialog("help");
      return;
    case "shortcuts":
      ctx.openDialog("shortcuts");
      return;
    case "model":
      ctx.openDialog("models");
      return;
    case "settings":
      ctx.openSettings();
      return;
    case "plugins":
      ctx.openSettings("extensiones");
      return;
    case "new":
      ctx.newChat();
      return;
    case "clear":
      if (chat) {
        // Runs once the chat's turn is over (it waits in the queue while one streams). The next
        // turn starts a new Claude Code session, so the old one's process goes now.
        closeClaudeCodeChat(chat.id, chat.messages.map((m) => m.responseMessages));
        ctx.patchChat(chat.id, { messages: [], contextTokens: 0, summary: "", compactedUpTo: 0, compactions: [], plan: "" });
        clearSystemPromptCache();
      }
      return;
    case "retry": {
      const lastUser = [...(chat?.messages ?? [])].reverse().find((m) => m.role === "user");
      if (lastUser?.content.trim()) ctx.send(textPayload(lastUser.content, ctx.modelId));
      return;
    }
    case "copy": {
      const lastAssistant = [...(chat?.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.content.trim());
      if (lastAssistant) await navigator.clipboard.writeText(stripToolMarkers(lastAssistant.content)).catch(() => {});
      return;
    }
    case "compact":
      await compact(ctx);
      return;
    case "plan":
      if (ctx.permissionMode === "plan" && !ctx.allowPermissionBypass) {
        ctx.promptEnableBypass();
        return;
      }
      ctx.setPermissionMode(ctx.permissionMode === "plan" ? "skip" : "plan");
      return;
    case "doctor":
      if (wantsJson) ctx.reply(toJsonBlock(await buildDoctorReport({ model: ctx.modelId, workspace: ctx.workspace })));
      else ctx.openDialog("doctor");
      return;
    case "status": {
      const report = await buildStatusReport({
        model: ctx.modelId,
        workspace: ctx.workspace,
        permissionMode: ctx.permissionMode,
        contextTokens: chat?.contextTokens,
        messageCount: chat?.messages.length,
      });
      ctx.reply(wantsJson ? toJsonBlock(report) : formatStatusText(report));
      return;
    }
    case "mcp": {
      const report = buildMcpReport();
      ctx.reply(wantsJson ? toJsonBlock(report) : formatMcpText(report));
      return;
    }
    case "skills": {
      const report = await buildSkillsReport(ctx.workspace);
      ctx.reply(wantsJson ? toJsonBlock(report) : formatSkillsText(report));
      return;
    }
    case "verify-plan":
      if (!chat?.plan?.trim()) {
        ctx.reply("No hay ningún plan que verificar. Crea uno en modo plan (`/plan`) y aplícalo antes de verificar.");
        return;
      }
      ctx.send(textPayload(verifyPlanPrompt(chat.plan), ctx.selectedModelId), "Verify plan execution");
      return;
  }
}

async function compact(ctx: BuiltinContext): Promise<void> {
  const { chat } = ctx;
  if (!chat) {
    ctx.reply("No hay suficiente conversación para compactar todavía.");
    return;
  }
  const { signal, release } = ctx.startCompact(chat.id);
  let startedAt = Date.now();
  try {
    const patch = await compactChat({
      chat,
      modelId: ctx.modelId,
      settings: ctx.settings,
      workspace: ctx.workspace,
      planMode: ctx.permissionMode === "plan",
      effort: ctx.effort,
      signal,
      onStart: () => {
        startedAt = Date.now();
        ctx.setCompacting(chat.id, true);
      },
    });
    if (patch === "tooShort") {
      ctx.reply("No hay suficiente conversación para compactar todavía.");
      return;
    }
    // Stopped after the summary came back: the conversation stays as it was all the same.
    if (signal.aborted) return;
    const last = chat.messages.at(-1);
    const mark: CompactionMark | null = last
      ? { afterId: last.id, ms: Date.now() - startedAt, beforeTokens: chat.contextTokens || undefined, afterTokens: patch.contextTokens || undefined }
      : null;
    ctx.patchChat(chat.id, mark ? { ...patch, compactions: [...(chat.compactions ?? []), mark] } : patch);
  } catch (err) {
    // The conversation stays as it was.
    if (!signal.aborted) ctx.reply(`No se pudo compactar la conversación: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    release();
    ctx.setCompacting(chat.id, false);
  }
}
