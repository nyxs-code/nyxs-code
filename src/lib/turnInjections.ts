import type { ModelMessage } from "ai";
import { emitEvent } from "./events";
import { gitSnapshotMessage, type InjectedState } from "./promptPrefix";
import { detectReplyLanguage, languageCheckNote } from "./replyLanguage";
import { formatSystemReminder, reminderUpdates, type SystemReminderState } from "./systemPrompt";
import type { TurnHooks } from "./turnHooks";
import type { ChatTurn } from "./turnInput";

/**
 * User messages added after the history, before this turn's first call:
 * hook context, reminders and git state that changed since they were last
 * sent, and the reply-language note. The system prompt itself stays fixed so
 * the prompt cache keeps hitting.
 */
export async function buildTurnInjections(o: {
  history: ChatTurn[];
  hooks: TurnHooks;
  workspace?: string | null;
  modelId: string;
  /** What earlier turns already injected. */
  promptState: InjectedState;
  reminders: SystemReminderState[];
  gitContext: string;
}): Promise<ModelMessage[]> {
  const { history, hooks, workspace, promptState } = o;
  const injected: ModelMessage[] = [];

  if (history.filter((t) => t.role === "user").length <= 1) {
    emitEvent({ type: "session.started", workspace: workspace ?? undefined, model: o.modelId });
    const startHooks = await hooks.fire({ hook_event_name: "SessionStart", cwd: workspace ?? undefined });
    if (startHooks.context.length) {
      injected.push({
        role: "user",
        content: `[Session start context]\n${startHooks.context.join("\n\n")}`,
      });
    }
  }

  const lastUser = [...history].reverse().find((t) => t.role === "user")?.content;
  const promptHooks = await hooks.fire({
    hook_event_name: "UserPromptSubmit",
    cwd: workspace ?? undefined,
    prompt: lastUser,
  });
  if (promptHooks.context.length) {
    injected.push({
      role: "user",
      content: `[Context added by hooks]\n${promptHooks.context.join("\n\n")}`,
    });
  }

  for (const r of reminderUpdates(promptState.reminders, o.reminders)) {
    injected.push({ role: "user", content: formatSystemReminder(r.id, r.content) });
  }

  const gitNow = o.gitContext.trim();
  if (gitNow && gitNow !== promptState.lastGit) injected.push(gitSnapshotMessage(gitNow));

  const replyLang = lastUser ? detectReplyLanguage(lastUser) : null;
  if (replyLang) injected.push({ role: "user", content: languageCheckNote(replyLang) });

  return injected;
}
