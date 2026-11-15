import { stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { invoke } from "@/lib/ipc";
import { lspDisposeWorkspace } from "./lsp";
import { APPLY_PATCH_TOOL_NAME, buildTools, resolveSubagentType, usesApplyPatch, CONTENT_WRITE_TOOLS, type AgentPathScope, type ContentExtractor, type FileEditTracker, type PermissionGate, patchFileStats, type SubagentDef, type SubagentRunner } from "./agentTools";
import { callModel } from "./callModel";
import { compactionBudget } from "./contextBudget";
import { newToolSession, type ToolSession } from "./fileStateCache";
import { liveToolResultFingerprints, PRUNE_TRIGGER_RATIO } from "./microcompact";
import { MAX_API_RETRIES } from "./modelClient";
import { getContextWindow, getModel, PROVIDERS, supportsVideo, videoModelKey, type ModelInfo } from "./models";
import type { PreflightBundle } from "./preflight";
import type { Settings } from "./settings";
import { buildSubagentSystemPrompt, type SubagentParentContext } from "./subagentPrompts";
import { buildToolDetail, describeToolCall } from "./toolDetail";
import { createCompactor, TurnContext } from "./turnContext";
import { MAX_SUBAGENT_STEPS, SUBAGENT_REPORT_PROMPT, inertTools, isContextOverflowError, repairMalformedToolCall, toolSchemaChars } from "./turnSupport";
import type { ActivityEvent } from "./agentActivity";
import { newAgentId, withStoppedNote } from "./orchestrator";
import { getWorkflowStore } from "./workflowSession";
import { withWorktree, worktreeSupported } from "./worktree";
import { isInside, normalizePath, resolvePath } from "@/tools/paths";

/** Worktree ids must be unique beyond this process: the counter starts over on every launch, and
 *  another Nyxs on the same project would otherwise rebuild (and wipe) a tree one of ours is using. */
const RUN_TOKEN = Math.random().toString(36).slice(2, 8);

type SubagentEdit = { path: string; added: number; removed: number };

/** Agents defined in agent files and plugins; a file agent wins over a plugin one with the same name. */
export function collectExtraAgents(fileAgents: PreflightBundle["agents"], plugins: PreflightBundle["plugins"]): SubagentDef[] {
  const out: SubagentDef[] = fileAgents.map((a) => ({
    type: a.name,
    whenToUse: a.whenToUse,
    readOnly: false,
    toolsLabel: a.tools?.length ? a.tools.join(", ") : "inherited",
    systemPrompt: a.body,
    tools: a.tools,
    model: a.model,
    source: a.source,
  }));
  for (const a of plugins?.agents ?? []) {
    if (out.some((e) => e.type === a.name)) continue;
    out.push({
      type: a.name,
      whenToUse: a.whenToUse ?? a.description ?? "",
      readOnly: false,
      toolsLabel: a.tools?.length ? a.tools.join(", ") : "inherited",
      systemPrompt: a.content,
      tools: a.tools,
      model: a.model,
      source: "user",
    });
  }
  return out;
}

/** What sub-agent tools are built with; mirrors the parent turn's tool options. */
export interface SubagentToolOptions {
  planMode: boolean;
  gate?: PermissionGate;
  onFileEdit?: FileEditTracker;
  confirmBeforeWrite: boolean;
  allowPdf: boolean;
  allowImages: boolean;
  nativeToolImages: boolean;
  nativeVideo?: string;
  pathScope: AgentPathScope;
  extract: ContentExtractor;
  /** The session's saved-environment variables, for the sub-agent's commands too. */
  env?: Record<string, string>;
  /** The parent's chat, whose built-in browser the sub-agent drives. */
  browserChat?: string;
}

export interface SubagentContext {
  isTauri: boolean;
  workspace: string;
  model: ModelInfo;
  languageModel: LanguageModel;
  settings: Settings;
  buildModel: (model: ModelInfo, settings: Settings) => LanguageModel;
  /** The parent's system prompt, which a fork reuses. */
  mainSystem: string;
  /** The parent's messages at the time of the call, which a fork continues from. */
  getMessages: () => ModelMessage[];
  extraAgents: SubagentDef[];
  /** The parent's file state, which a fork starts from. */
  toolSession: ToolSession;
  tools: SubagentToolOptions;
  compatMaxOutputTokens: number;
  maxSteps?: number;
  isolateSubagents: boolean;
  /** A sub-agent edited a file: its line counts, for the turn's changes card. */
  onSubagentEdit?: (edit: SubagentEdit) => void;
  signal?: AbortSignal;
  /** The parent's chat, whose Workflow view shows its sub-agents. */
  chatId?: string;
  /** The project's instructions, the date and the user's language, for a sub-agent that doesn't
   *  inherit the parent's prompt (a fork does). */
  parentContext?: SubagentParentContext;
}

/** "Permission denied…", the truncation warning, a patch that didn't apply and similar refusals
 *  come back as ordinary text. */
function editRefused(output: unknown): boolean {
  if (typeof output !== "string") return false;
  const head = output.trimStart();
  return head.startsWith("Permission denied") || head.startsWith("ERROR");
}

/** An isolated sub-agent writes inside its worktree; the changes card counts paths of the project. */
export function projectPath(filePath: string, effectiveWs: string, workspace: string): string {
  try {
    const abs = resolvePath(filePath, effectiveWs);
    if (effectiveWs === workspace) return abs;
    // The worktree's own separator: `\` on Windows, `/` on Linux and macOS.
    const base = normalizePath(effectiveWs.replace(/[\\/]+$/, ""));
    if (abs === base || !isInside(abs, base)) return filePath;
    return resolvePath(abs.slice(base.length).replace(/^[\\/]+/, ""), workspace);
  } catch {
    return filePath;
  }
}

export function createSubagentRunner(ctx: SubagentContext): SubagentRunner {
  const { workspace, model, languageModel, settings, tools: toolOpts } = ctx;

  const resolveSubModel = (id: string | undefined) => {
    if (!id) return { lm: languageModel, info: model };
    const mi = getModel(id, settings);
    if (!mi) return { lm: languageModel, info: model };
    try {
      return { lm: ctx.buildModel(mi, settings), info: mi };
    } catch {
      return { lm: languageModel, info: model };
    }
  };

  const fullSubToolsFor = (baseWs: string, session: ToolSession, patchEdits: boolean, nativeVideo: string | undefined): ToolSet => {
    const isolated = baseWs !== workspace;
    const all = buildTools({
      patchEdits,
      workspace: baseWs,
      planMode: toolOpts.planMode,
      gate: toolOpts.gate,
      onFileEdit: isolated ? undefined : toolOpts.onFileEdit,
      confirmBeforeWrite: toolOpts.confirmBeforeWrite,
      allowPdf: toolOpts.allowPdf,
      allowImages: toolOpts.allowImages,
      nativeToolImages: toolOpts.nativeToolImages,
      nativeVideo,
      pathScope: toolOpts.pathScope,
      session,
      extract: toolOpts.extract,
      env: toolOpts.env,
      browserChat: toolOpts.browserChat,
    });
    delete all.TodoWrite;
    delete all.WritePlan;
    delete all.Preview;
    return all;
  };

  const pickSubTools = (all: ToolSet, allowed: string[]): ToolSet => {
    const want = new Set(allowed);
    // An agent file that lists the file tools means whichever ones its model has.
    if (["Write", "Edit", "MultiEdit"].some((n) => want.has(n))) want.add(APPLY_PATCH_TOOL_NAME);
    const out: ToolSet = {};
    for (const [name, t] of Object.entries(all)) if (want.has(name)) out[name] = t;
    return Object.keys(out).length ? out : all;
  };

  return async ({ prompt, subagentType, model: modelOverride, fork, signal: taskSignal, onUsage: onSubUsage, onActivity, reflect = true }) => {
    let subModelId = modelOverride;
    const wfStore = getWorkflowStore(ctx.chatId);
    const wfId = newAgentId();
    // Its own signal, so the user can stop this agent alone; the turn's stop still reaches it.
    const own = new AbortController();
    const parentSignal = taskSignal ?? ctx.signal;
    const relay = () => own.abort();
    parentSignal?.addEventListener("abort", relay, { once: true });
    if (parentSignal?.aborted) own.abort();
    // Stopped from the background tasks view (or TaskStop) while the turn itself goes on.
    const stoppedByUser = () => own.signal.aborted && !ctx.signal?.aborted;
    const reportActivity = (activity: ActivityEvent) => {
      onActivity?.(activity);
      if (reflect) wfStore.dispatch({ kind: "agent:activity", id: wfId, activity });
    };

    const def = fork ? null : resolveSubagentType(subagentType, ctx.extraAgents);

    if (def?.systemPrompt && !modelOverride && def.model) subModelId = def.model;

    const subMessages: ModelMessage[] = fork
      ? [...ctx.getMessages(), { role: "user", content: prompt }]
      : [{ role: "user", content: prompt }];

    const buildSubSystem = (baseWs: string): string => {
      if (fork) return ctx.mainSystem;
      let s = buildSubagentSystemPrompt(baseWs, def!.readOnly, ctx.maxSteps ?? MAX_SUBAGENT_STEPS, ctx.parentContext);

      if (def!.systemPrompt) s += `\n\n# Agent: ${def!.type}\n\n${def!.systemPrompt}`;
      return s;
    };
    /** The sub-agent's tools, and the file state they share (its context pruning updates which
     *  reads are still visible). */
    const buildSubTools = (baseWs: string): { tools: ToolSet; session: ToolSession } => {
      if (fork) {
        // A fork keeps the main agent's system prompt, so it keeps its file tools too.
        const session = { fileState: ctx.toolSession.fileState.clone(), visibleReads: new Set(ctx.toolSession.visibleReads) };
        return { tools: fullSubToolsFor(baseWs, session, usesApplyPatch(model.apiModel), toolOpts.nativeVideo), session };
      }
      const patchEdits = usesApplyPatch(subModelInfo.apiModel);
      // The sub-agent may run on another model, which decides whether it watches whole videos.
      const nativeVideo = supportsVideo(subModelInfo) ? videoModelKey(subModelInfo) : undefined;
      const session = newToolSession();
      if (def!.readOnly) {
        const all = buildTools({
          workspace: baseWs,
          planMode: true,
          gate: toolOpts.gate,
          allowPdf: toolOpts.allowPdf,
          allowImages: toolOpts.allowImages,
          nativeToolImages: toolOpts.nativeToolImages,
          nativeVideo,
          pathScope: toolOpts.pathScope,
          extract: toolOpts.extract,
          session,
        });
        return {
          tools: { Read: all.Read, Glob: all.Glob, Grep: all.Grep, ListDir: all.ListDir, ReadPdf: all.ReadPdf, WatchVideo: all.WatchVideo, WebFetch: all.WebFetch, WebSearch: all.WebSearch },
          session,
        };
      }
      const all = fullSubToolsFor(baseWs, session, patchEdits, nativeVideo);
      return { tools: def!.tools?.length ? pickSubTools(all, def!.tools) : all, session };
    };

    const { lm: subModel, info: subModelInfo } = resolveSubModel(subModelId);
    const subCompatMaxOutput =
      PROVIDERS[subModelInfo.provider]?.kind === "openai-compatible" ||
      subModelInfo.provider === "minimax-anthropic"
        ? { maxOutputTokens: ctx.compatMaxOutputTokens }
        : {};

    const execute = async (effectiveWs: string, onEdit = ctx.onSubagentEdit): Promise<string> => {
      const subSystem = buildSubSystem(effectiveWs);
      const { tools: subTools, session: subSession } = buildSubTools(effectiveWs);
      const systemMessages: ModelMessage[] = [{ role: "system", content: subSystem }];
      const callOptions = { maxRetries: MAX_API_RETRIES, ...subCompatMaxOutput, abortSignal: own.signal };
      // The main agent's context handling, sized to this agent's own model: old tool results are
      // pruned, and what still doesn't fit is summarized (a fork's inherited history first, then
      // this run's first steps).
      const context = new TurnContext({
        budget: compactionBudget(getContextWindow(subModelInfo), subCompatMaxOutput.maxOutputTokens ?? ctx.compatMaxOutputTokens),
        overheadTokens: Math.ceil((subSystem.length + toolSchemaChars(subTools)) / 4),
        systemMessages,
        historyTurns: 1,
        compact: createCompactor({
          model: subModel,
          systemMessages,
          isAnthropic: PROVIDERS[subModelInfo.provider]?.kind === "anthropic",
          tools: subTools,
          callOptions,
        }),
        onReshaped: (visible) => {
          subSession.visibleReads.clear();
          for (const print of liveToolResultFingerprints(visible, "Read")) subSession.visibleReads.add(print);
        },
        signal: own.signal,
      });
      context.setAnchor(subMessages.length - 2);
      context.setTurnStart(subMessages.length);
      let lastStepInput = 0;
      const prepareStep = async ({ messages: stepMessages, stepNumber }: { messages: ModelMessage[]; stepNumber: number }) => {
        if (stepNumber > 0 && lastStepInput > context.budgetWindow * PRUNE_TRIGGER_RATIO) {
          await context.relieveStepPressure(stepMessages, lastStepInput);
        }
        const shaped = context.shape(stepMessages);
        return shaped !== stepMessages ? { messages: shaped } : {};
      };
      const startPass = () =>
        callModel({
          model: subModel,
          messages: [...systemMessages, ...subMessages],
          tools: subTools,
          stopWhen: stepCountIs(ctx.maxSteps ?? MAX_SUBAGENT_STEPS),
          prepareStep,
          // Before the next step's prepareStep, which the stream below may not have caught up to.
          onStepFinish: (step) => {
            lastStepInput = step.usage?.inputTokens ?? lastStepInput;
          },
          repairToolCall: repairMalformedToolCall,
          ...callOptions,
        });
      let sub = startPass();
      let text = "";
      let subIn = 0;
      let subOut = 0;
      let subError: unknown = null;
      let overflowRetried = false;
      // A sub-agent's tool calls never reach the chat, so its edits are read here, at call time
      // (before the write runs) and reported on the result: that is what the changes card counts.
      const editDetails = new Map<string, { path: string; added: number; removed: number }[]>();
      for (;;) {
        try {
          for await (const part of sub.fullStream) {
            if (part.type === "text-delta") {
              text += part.text;
              reportActivity({ kind: "text", delta: part.text });
            } else if (part.type === "tool-call") {
              const label = describeToolCall(part.toolName, part.input);
              reportActivity({ kind: "tool-call", callId: part.toolCallId, name: label.name, detail: label.detail });
              if (part.toolName === APPLY_PATCH_TOOL_NAME) {
                editDetails.set(part.toolCallId, patchFileStats(String((part.input as { input?: unknown })?.input ?? "")));
              } else if (CONTENT_WRITE_TOOLS.has(part.toolName)) {
                const built = await buildToolDetail(part.toolName, part.input, effectiveWs).catch(() => null);
                if (built) editDetails.set(part.toolCallId, [{ path: built.detail, added: built.added ?? 0, removed: built.removed ?? 0 }]);
              }
            } else if (part.type === "tool-result") {
              const output = (part as { output?: unknown }).output;
              reportActivity({ kind: "tool-result", callId: part.toolCallId, ok: !editRefused(output) });
              const files = editDetails.get(part.toolCallId);
              editDetails.delete(part.toolCallId);
              if (files && !editRefused(output)) {
                for (const f of files) onEdit?.({ ...f, path: projectPath(f.path, effectiveWs, workspace) });
              }
            } else if (part.type === "tool-error") {
              reportActivity({ kind: "tool-result", callId: part.toolCallId, ok: false });
              editDetails.delete(part.toolCallId);
            } else if (part.type === "error") {
              subError = part.error;
            } else if (part.type === "finish-step") {
              const u = part.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
              subOut += u?.outputTokens ?? u?.totalTokens ?? 0;
              const inp = u?.inputTokens ?? 0;
              if (inp > subIn) subIn = inp;
            }
          }
        } catch (e) {
          if (stoppedByUser()) break;
          if (!isContextOverflowError(e)) throw e;
          subError = e;
        }
        // The provider turned a request down as too long: free what can be freed and run again
        // once, as the main agent does.
        if (!overflowRetried && !stoppedByUser() && subError && isContextOverflowError(subError)) {
          overflowRetried = true;
          if (await context.forceRelief(subMessages)) {
            subError = null;
            sub = startPass();
            continue;
          }
        }
        break;
      }
      if (stoppedByUser()) {
        onSubUsage?.({ inputTokens: subIn, outputTokens: subOut });
        return withStoppedNote(text);
      }
      let finalText = "";
      let cutOff = false;
      if (!subError) {
        const steps = await sub.steps;
        const last = steps[steps.length - 1];
        finalText = last?.text ?? "";
        cutOff = last?.finishReason === "length";
        const signal = own.signal;
        if (last?.finishReason === "tool-calls" && !signal?.aborted) {
          try {
            const closing = callModel({
              model: subModel,
              messages: [
                ...context.shape([...systemMessages, ...subMessages, ...(await sub.response).messages]),
                { role: "user", content: SUBAGENT_REPORT_PROMPT },
              ],
              tools: inertTools(subTools),
              stopWhen: stepCountIs(1),
              ...callOptions,
            });
            let closingText = "";
            for await (const part of closing.fullStream) {
              if (part.type === "text-delta") closingText += part.text;
              else if (part.type === "finish-step") {
                const u = part.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
                subOut += u?.outputTokens ?? u?.totalTokens ?? 0;
                subIn = Math.max(subIn, u?.inputTokens ?? 0);
              }
            }
            if (closingText.trim()) finalText = closingText;
          } catch {
            finalText = "";
          }
        }
      }
      onSubUsage?.({ inputTokens: subIn, outputTokens: subOut });
      if (subError && !text.trim()) throw subError instanceof Error ? subError : new Error(String(subError));
      const report = finalText.trim() || text.trim() || "(the sub-agent finished without producing a report)";
      // Without the note the agent that delegated would take a report cut mid-sentence as whole.
      if (cutOff) return `${report}\n\n[The sub-agent's last reply was cut off: it ran out of output tokens.]`;
      if (!subError) return report;
      const reason = subError instanceof Error ? subError.message : String(subError);
      return `${report}\n\n[The sub-agent stopped early because of an error: ${reason.slice(0, 400)}]`;
    };

    const wfLabel =
      (subagentType || (fork ? "fork" : "agent")) +
      (prompt ? `: ${prompt.replace(/\s+/g, " ").trim().slice(0, 48)}` : "");
    const wfStart = Date.now();
    if (reflect) {
      if (wfStore.getSnapshot().running === 0) wfStore.reset();
      wfStore.dispatch({ kind: "agent:start", id: wfId, label: wfLabel, phase: "Sub-agents", stop: relay });
    }
    let wfOk = false;
    try {
      const canIsolate = ctx.isolateSubagents && ctx.isTauri && !fork && !!def && !def.readOnly && !!workspace;
      let result: string;
      if (canIsolate && (await worktreeSupported(workspace))) {
        // A patch that can't be merged back (the user touched the same lines meanwhile) must not
        // swallow the agent's whole run: keep the report and tell the parent.
        let mergeError = "";
        // Its edits land in the project only when the patch goes in: count them then, not as it writes.
        const edits: SubagentEdit[] = [];
        const report = await withWorktree(
          workspace,
          `sub-${RUN_TOKEN}-${wfId}`,
          async (worktreePath) => {
            await invoke("agent_add_path_scope", { scope: toolOpts.pathScope.id, root: worktreePath });
            try {
              return await execute(worktreePath, (edit) => edits.push(edit));
            } finally {
              await invoke("agent_remove_path_scope", { scope: toolOpts.pathScope.id, root: worktreePath }).catch(() => undefined);
              // The language servers its edits started there would outlive the worktree.
              await lspDisposeWorkspace(worktreePath).catch(() => undefined);
            }
          },
          {
            onApplyError: (e) => {
              mergeError = e instanceof Error ? e.message : String(e);
            },
            // The worktree was detached from the project's tracking, so the files the patch lands
            // are reported here — before applying, so the changes view keeps the real "before".
            beforeApply: async (files) => {
              if (!toolOpts.onFileEdit) return;
              for (const f of files) {
                try {
                  await toolOpts.onFileEdit(resolvePath(f, workspace));
                } catch {
                  /* outside the project: skip */
                }
              }
            },
          },
        );
        if (!mergeError) for (const edit of edits) ctx.onSubagentEdit?.(edit);
        result = mergeError
          ? `${report}\n\n[The files this agent changed could not be merged back into the project: ${mergeError}]`
          : report;
      } else {
        result = await execute(workspace);
      }
      wfOk = true;
      return result;
    } finally {
      parentSignal?.removeEventListener("abort", relay);
      if (reflect) {
        wfStore.dispatch({
          kind: "agent:end",
          id: wfId,
          label: wfLabel,
          phase: "Sub-agents",
          ok: wfOk,
          ms: Date.now() - wfStart,
          stopped: stoppedByUser(),
        });
      }
    }
  };
}
