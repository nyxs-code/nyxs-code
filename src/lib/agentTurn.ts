import { stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { invoke } from "@/lib/ipc";
import { userSkillsDir, userAttachmentsDir, userForeignSkillsDirs } from "@/lib/paths";
import { getModel, getContextWindow, getActiveModels, supportsImages, supportsPdf, supportsVideo, videoModelKey, PROVIDERS, type ModelInfo } from "./models";
import { type Settings } from "./settings";
import { type EffortLevel } from "./effort";
import type { PublishedChange } from "./prDetect";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";
import { buildTools, usesApplyPatch, type AgentPathScope, type ToolDetail, type PermissionGate, type Todo, type FileEditTracker, type AskUserFn } from "./agentTools";
import { getDiagnosticsRuntime } from "./diagnostics";
import { detectReplyLanguage } from "./replyLanguage";
import { buildSystemPromptCacheBlocks, modelFamilyOf } from "./systemPrompt";
import { scanInjectedState, stripProviderExecutedParts } from "./promptPrefix";
import { getMergedSnapshot, setSettingsPollPaused, settingsFor } from "./settingsRuntime";
import { getOutputStyle } from "./outputStyles";
import { sessionSettingsFor } from "./sessionSettings";
import { buildSkillsListing } from "./skills";
import { loadMergedMcpServers, loadMcpTools, isMcpServerConfigured } from "./mcp";
import { cachedGitContext, cachedPreflight, EMPTY_PREFLIGHT } from "./preflight";
import { applyToolResultPruning, liveToolResultFingerprints, PRUNE_TRIGGER_RATIO, type PruneMap } from "./microcompact";
import { compactionBudget } from "./contextBudget";
import { trackShellChanges, type ShellChange } from "./shellChanges";
import { trackBackgroundShells, type BackgroundShellEvent } from "./backgroundWake";
import { callModel, type CallModelResult } from "./callModel";
import { newTurnStreamState, processTurnStream, streamErrorMessage, type TurnStreamSinks } from "./turnStream";
import { seenNestedDirs } from "../tools/Read/nested";
import { loadShellInfo } from "../tools/env";
import { FileStateCache, fileStateFor, type ToolSession } from "./fileStateCache";
import { recordPromptState } from "./promptCacheDebug";
import { emitEvent } from "./events";
import { isTauri, httpFetch, MAX_API_RETRIES, COMPAT_MAX_OUTPUT_TOKENS, warmModelRegistry, thinkingOptions, withPromptCacheKey, buildModel as defaultBuildModel } from "./modelClient";
import {
  timingEnabled,
  reportTurnTiming,
  MAX_AGENT_STEPS,
  uiSmoothing,
  isContextOverflowError,
  isTransientStreamError,
  createToolCallRepair,
  toolResultTexts,
  toolSchemaChars,
  toolPromptChars,
  inertTools,
  withCacheBreakpoint,
  buildSystemMessages,
  buildAutoFixPrompt,
  turnCacheStats,
  STEP_LIMIT_PROMPT,
  buildOutputLimitRetryPrompt,
  withoutThoughtOnlyTail,
} from "./turnSupport";
import { toModelMessage, describeAttachedImages, type ChatTurn, type CacheStats } from "./turnInput";
import { TurnContext, createCompactor, type Compacted, type TurnCallOptions } from "./turnContext";
import { collectExtraAgents, createSubagentRunner } from "./turnSubagents";
import { askAboutLoop, connectMcpTools, createExtractor, createWorkflowTool, deferTools, guardDoomLoops, sortToolsInPlace } from "./turnTools";
import { createTurnHooks, guardWithPreToolUse } from "./turnHooks";
import { buildTurnInjections } from "./turnInjections";
import type { TurnInbox } from "./turnInbox";
import { branchOfGitContext, prAutoFixOn } from "./prAutoFix";
import { envForSession } from "./environments";

/** How many times one turn recovers from the provider rejecting a request as too long. A long
 *  turn can fill the window again after it was relieved once. */
const MAX_OVERFLOW_RETRIES = 3;

export interface StreamChatOptions {
  modelId: string;
  history: ChatTurn[];
  settings: Settings;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  workspace?: string | null;
  onTool?: (id: string, detail: ToolDetail) => void;
  onUsage?: (tokens: number) => void;
  onContext?: (usedTokens: number) => void;
  planMode?: boolean;
  /** The chat's permission mode, for agents that can't ask before each tool (Antigravity CLI). */
  permissionMode?: PermissionMode;
  gate?: PermissionGate;
  onTodos?: (todos: Todo[]) => void;
  outputStylePrompt?: string;
  onPlan?: (plan: string) => void;
  onPreview?: (path: string) => void;
  onFileEdit?: FileEditTracker;
  confirmBeforeWrite?: boolean;
  askUser?: AskUserFn;
  thinking?: boolean;
  onReasoning?: (id: string, delta: string) => void;
  onMessages?: (messages: ModelMessage[], segment?: number) => void;
  onCacheStats?: (stats: CacheStats) => void;
  effort?: EffortLevel;
  sessionKey?: string;
  attachSession?: string;
  inbox?: TurnInbox;
  onCompacted?: (c: Compacted) => void;
  /** Claude Code finished compacting its own session; `preTokens` is the context before, when it says. */
  onNativeCompacted?: (c: { preTokens?: number }) => void;
  /** `native`: Claude Code compacting its own session, rather than Nyxs summarising the chat. */
  onCompacting?: (active: boolean, native?: boolean) => void;
  /** A request failed and will be sent again (in `waitMs`, when the agent says); null once it's
   *  going again. */
  onRetrying?: (retry: { rateLimited: boolean; waitMs?: number } | null) => void;
  /** Claude Code is being made ready on this machine; null once it is. */
  onRemoteSetup?: (host: string | null) => void;
  /** A subagent edited a file: its line counts, for the turn's changes card. */
  onSubagentEdit?: (edit: { path: string; added: number; removed: number }) => void;
  /** Claude Code reported a published code change (see claudeCodeStream's onPrPublished). */
  onPrPublished?: (change: PublishedChange) => void;
  onPruneToolResults?: (prune: PruneMap) => void;
  recallSession?: (query: string, maxResults: number) => Promise<string>;
  onShellChange?: (change: ShellChange) => void;
  onBackgroundShell?: (event: BackgroundShellEvent) => void;
  /** The most model steps this turn may take (headless `--max-steps`); the app's default otherwise. */
  maxSteps?: number;
  /** The model ran out of output tokens this turn. Called once, when the turn ends. */
  onOutputLimit?: (hit: OutputLimitHit) => void;
}

/** A turn where the model reached its output-token limit. */
export interface OutputLimitHit {
  /** The turn's last reply was cut off (the retry, when there was one, was cut too). */
  cut: boolean;
  /** A step that only thought was cut, and was run again once asking the model to act. */
  retried: boolean;
  /** The limit Nyxs sent, when `generation.maxOutputTokens` sets it. */
  limit?: number;
}

export interface AgentTurnDeps {
  isTauri: boolean;
  buildModel: (model: ModelInfo, settings: Settings) => LanguageModel;
  maxSteps?: number;
  extraTools?: ToolSet;
}

export function defaultAgentTurnDeps(): AgentTurnDeps {
  return { isTauri, buildModel: defaultBuildModel };
}

export async function runAgentTurn(chatOptions: StreamChatOptions, deps: AgentTurnDeps): Promise<string> {
  // Runs however the turn ends: done, aborted or failed.
  const cleanup: Array<() => Promise<void>> = [];
  try {
    return await agentTurn(chatOptions, deps, cleanup);
  } finally {
    for (const done of cleanup) await done().catch(() => {});
  }
}

async function agentTurn(
  chatOptions: StreamChatOptions,
  deps: AgentTurnDeps,
  cleanup: Array<() => Promise<void>>,
): Promise<string> {
  const {
    modelId,
    history,
    settings,
    onChunk,
    signal,
    workspace,
    onTool,
    onUsage,
    onContext,
    planMode = false,
    gate,
    onTodos,
    outputStylePrompt = "",
    onPlan,
    onPreview,
    onFileEdit,
    confirmBeforeWrite = false,
    askUser,
    thinking = false,
    onReasoning,
    onMessages,
    onCacheStats,
    onOutputLimit,
    effort = "medium",
    sessionKey,
    onCompacted,
    onCompacting,
    onPruneToolResults,
    recallSession,
    onShellChange,
    onBackgroundShell,
    onSubagentEdit,
    inbox,
  } = chatOptions;
  const model = getModel(modelId, settings);
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  const isTauri = deps.isTauri;
  const buildModel = deps.buildModel;
  const maxSteps = deps.maxSteps ?? chatOptions.maxSteps ?? MAX_AGENT_STEPS;

  void warmModelRegistry();
  const turnStart = Date.now();
  const marks: Record<string, number> = {};
  const mark = (name: string) => {
    if (marks[name] === undefined) marks[name] = Date.now() - turnStart;
  };

  const languageModel = buildModel(model, settings);

  // ── History as model messages ────────────────────────────────────────────
  const allowImages = supportsImages(model);
  const allowPdf = supportsPdf(model);
  const nativeToolImages = PROVIDERS[model.provider].kind !== "openai-compatible";
  const nativeVideo = supportsVideo(model) ? videoModelKey(model) : undefined;
  const visionDescriptions = allowImages ? undefined : await describeAttachedImages(history);
  const keepProviderParts = PROVIDERS[model.provider]?.kind === "anthropic";
  const turnStarts: number[] = [];
  let messages: ModelMessage[] = [];
  for (const t of history) {
    turnStarts.push(messages.length);
    const raw = t.messages && t.messages.length ? t.messages : [toModelMessage(t, allowImages, visionDescriptions)];
    messages.push(...(keepProviderParts ? raw : stripProviderExecutedParts(raw)));
  }
  const injectedState = scanInjectedState(messages);

  const reasoningOpts = withPromptCacheKey(thinkingOptions(model, effort, thinking), model, sessionKey);

  // ── Workspace, project config and MCP, loaded in parallel ────────────────
  const toolsEnabled = isTauri && !!workspace;

  if (toolsEnabled) await loadShellInfo();
  // The settings of the turn's own folder: a chat of another project (a session woken in the
  // background) runs with its own MCP servers and options, not those of the folder open in the app.
  const turnSettings = (await settingsFor(workspace ?? undefined).catch(() => null))?.merged ?? getMergedSnapshot();
  // Only a session started from a saved environment runs its commands with its variables.
  const sessionEnv = await envForSession(sessionKey).catch(() => undefined);
  const pathScope: AgentPathScope = { id: workspace ?? "", extraRoots: [] };
  const toolSession: ToolSession = {
    fileState: sessionKey ? fileStateFor(sessionKey) : new FileStateCache(),
    visibleReads: liveToolResultFingerprints(messages, "Read"),
    nestedInstructions: seenNestedDirs(toolResultTexts(messages, "Read")),
  };

  const setupPathScope = async (): Promise<void> => {
    if (!toolsEnabled) return;
    try {
      const foreign = await userForeignSkillsDirs();
      pathScope.extraRoots = [await userSkillsDir(), await userAttachmentsDir(), ...foreign].map((p) => p.replace(/\//g, "\\"));
    } catch {
      pathScope.extraRoots = [];
    }
    await invoke("agent_set_path_scope", { scope: pathScope.id, roots: [workspace!, ...pathScope.extraRoots] });
  };

  const enabledMcpServers = isTauri ? loadMergedMcpServers(workspace ?? undefined).filter((s) => s.enabled && isMcpServerConfigured(s)) : [];
  // OpenAI-compatible endpoints get a tool's images too, moved into a user message (withToolMedia).
  const mcpToolImages = allowImages;

  const [preflight, gitContext, mcpLoaded] = await Promise.all([
    toolsEnabled ? cachedPreflight(workspace!) : Promise.resolve(EMPTY_PREFLIGHT),
    isTauri && workspace ? cachedGitContext(workspace) : Promise.resolve(""),
    isTauri && enabledMcpServers.length > 0
      ? loadMcpTools(enabledMcpServers, { fetchImpl: (httpFetch ?? fetch) as typeof fetch, toolImages: mcpToolImages })
      : Promise.resolve({ tools: {} as ToolSet, errors: [] as string[] }),
    setupPathScope(),
  ]);

  mark("preflight");

  const { skills: allSkills, plugins: pluginComps, agents: fileAgents, memory: projectMemory, claudeMemory } = preflight;

  const wfCfg = (turnSettings as { workflow?: { enabled?: boolean; maxAgents?: number } }).workflow;
  const wfEnabled = toolsEnabled && Boolean(wfCfg?.enabled);

  const skills = wfEnabled ? allSkills.filter((s) => s.name !== "review") : allSkills;
  const extraAgents = collectExtraAgents(fileAgents, pluginComps);

  // ── System prompt ────────────────────────────────────────────────────────
  const mcpInstructions = enabledMcpServers.length
    ? `# MCP servers (external tools)
You are connected to these MCP servers. Their tools are named \`mcp__<server>__<tool>\`; use them when relevant to the task:
${enabledMcpServers.map((s) => `- ${s.name}`).join("\n")}`
    : "";

  const workflowInstructions = wfEnabled
    ? `# Workflow tool
For a multi-dimension code review, or whenever the user asks to "use Workflow", call the \`Workflow\` tool DIRECTLY in one step (mode "review" for reviews, "parallel" for fan-out over items). Do NOT first explore the project manually and do NOT run a separate "review" skill — that duplicates the sub-agent fan-out. Each workflow agent inspects the code it needs on its own; just pass the target as \`task\`.`
    : "";

  const mergedSettings = turnSettings;
  const replyLanguage = (mergedSettings.language ?? "").toString();
  const today = new Date().toISOString().slice(0, 10);
  const sessionSettings = sessionSettingsFor(sessionKey, mergedSettings);
  const effectiveOutputStylePrompt = getOutputStyle(sessionSettings.outputStyle).prompt || outputStylePrompt;

  const compatMaxOutputTokens =
    (mergedSettings as { generation?: { maxOutputTokens?: number } }).generation?.maxOutputTokens ??
    COMPAT_MAX_OUTPUT_TOKENS;

  const patchEdits = toolsEnabled && usesApplyPatch(model.apiModel);
  const { blocks: systemBlocks, cacheIndex, reminders: systemReminders } = buildSystemPromptCacheBlocks({
    workspace: workspace ?? null,
    skillsListing: buildSkillsListing(skills),
    planMode,
    projectMemory,
    claudeMemory,
    outputStylePrompt: effectiveOutputStylePrompt,
    language: replyLanguage,
    gitRepo: Boolean(gitContext.trim()),
    confirmBeforeWrite,
    mcpInstructions,
    workflowInstructions,
    autoPullRequest:
      (mergedSettings as { pullRequests?: { autoCreate?: boolean } }).pullRequests?.autoCreate ?? false,
    autoFixPullRequest:
      ((mergedSettings as { pullRequests?: { autoFix?: boolean } }).pullRequests?.autoFix ?? false) ||
      prAutoFixOn(workspace ?? null, branchOfGitContext(gitContext)),
    date: today,
    leanReasoning: model.provider === "minimax-anthropic",
    modelFamily: modelFamilyOf(model.provider, model.apiModel),
    patchEdits,
  });
  const mainSystem = systemBlocks.join("\n\n");

  // ── Tools ────────────────────────────────────────────────────────────────
  const extract = createExtractor({
    model,
    languageModel,
    settings,
    buildModel,
    helperModelId: (mergedSettings as { helperModel?: string }).helperModel,
    signal,
  });

  const runSubagent = toolsEnabled
    ? createSubagentRunner({
        isTauri,
        workspace: workspace!,
        model,
        languageModel,
        settings,
        buildModel,
        mainSystem,
        // What this turn did too: the pass's history and its finished steps, not the step calling the fork.
        getMessages: () => [...convo, ...withInjections(passSteps, 0)],
        extraAgents,
        toolSession,
        tools: { planMode, gate, onFileEdit, confirmBeforeWrite, allowPdf, allowImages, nativeToolImages, nativeVideo, pathScope, extract, env: sessionEnv, browserChat: sessionKey },
        compatMaxOutputTokens,
        maxSteps: (mergedSettings as { generation?: { subagentMaxSteps?: number } }).generation?.subagentMaxSteps,
        isolateSubagents:
          (turnSettings as { worktree?: { isolateSubagents?: boolean } }).worktree?.isolateSubagents ?? false,
        onSubagentEdit,
        signal,
        chatId: sessionKey,
        parentContext: {
          projectInstructions: projectMemory,
          date: today,
          language: detectReplyLanguage([...history].reverse().find((t) => t.role === "user")?.content ?? ""),
        },
      })
    : undefined;

  const localTools = toolsEnabled
    ? buildTools({
        workspace: workspace!,
        skills,
        planMode,
        gate,
        onFileEdit,
        runSubagent,
        subagentModels: getActiveModels(settings).map((m) => m.id),
        askUser,
        confirmBeforeWrite,
        extraAgents,
        allowPdf,
        allowImages,
        nativeToolImages,
        nativeVideo,
        pathScope,
        session: toolSession,
        extract,
        recall: recallSession,
        env: sessionEnv,
        sessionKey,
        patchEdits,
      })
    : {};

  const mcpTools = isTauri && enabledMcpServers.length > 0 ? connectMcpTools(mcpLoaded, gate, onChunk, askUser) : {};

  const tools: ToolSet = { ...localTools, ...mcpTools, ...(deps.extraTools ?? {}) };

  if (wfEnabled && runSubagent) {
    tools.Workflow = createWorkflowTool(
      runSubagent,
      { modelId, settings, workspace: workspace ?? null, gate, effort, onUsage },
      wfCfg?.maxAgents ?? 12,
      signal,
      sessionKey,
    );
  }

  const { deferredNames, activeToolNames, deferActive } = deferTools(
    tools,
    Object.keys(mcpTools),
    model,
    injectedState.activatedTools,
    sessionSettings.toolAccessMode,
  );
  sortToolsInPlace(tools);

  const hasTools = Object.keys(tools).length > 0;

  // ── Output to the UI ─────────────────────────────────────────────────────
  let full = "";
  let reasonSeq = 0;
  let reasonPhaseId: string | null = null;
  const emit = (text: string) => {
    mark("firstPaint");
    reasonPhaseId = null;
    full += text;
    onChunk(text);
  };
  const emitReasoning = (text: string) => {
    if (!text) return;
    mark("firstReasoning");
    if (reasonPhaseId === null) {
      const id = `r${++reasonSeq}`;
      emit(`\n\n⟦REASONING⟧${id}⟦/REASONING⟧\n\n`);
      reasonPhaseId = id;
    }
    onReasoning?.(reasonPhaseId, text);
  };

  // ── Guards around tool calls (innermost first) ───────────────────────────
  const hooks = createTurnHooks({ enabled: isTauri, workspace, signal, emit });

  const shellTracker =
    isTauri && workspace && onShellChange && !planMode ? trackShellChanges(tools, workspace, onShellChange) : null;
  if (shellTracker) cleanup.push(shellTracker.finish);
  if (onBackgroundShell) trackBackgroundShells(tools, onBackgroundShell);

  // A chat that asks before acting asks about a repeated call too; other modes tell the model.
  guardDoomLoops(tools, chatOptions.permissionMode === "ask" && askUser ? askAboutLoop(askUser) : undefined);
  guardWithPreToolUse(tools, hooks, workspace);

  // ── Context budget ───────────────────────────────────────────────────────
  const isAnthropic = PROVIDERS[model.provider]?.kind === "anthropic";
  const systemMessages = buildSystemMessages(systemBlocks, cacheIndex, isAnthropic);

  const needsExplicitMaxOutput = PROVIDERS[model.provider]?.kind === "openai-compatible" || model.provider === "minimax-anthropic";
  const compatMaxOutput = needsExplicitMaxOutput ? { maxOutputTokens: compatMaxOutputTokens } : {};
  const callOptions: TurnCallOptions = { maxRetries: MAX_API_RETRIES, ...compatMaxOutput, abortSignal: signal, ...reasoningOpts };

  const refreshVisibleReads = (msgs: ModelMessage[]) => {
    toolSession.visibleReads.clear();
    for (const print of liveToolResultFingerprints(msgs, "Read")) toolSession.visibleReads.add(print);
    toolSession.nestedInstructions = seenNestedDirs(toolResultTexts(msgs, "Read"));
  };

  const context = new TurnContext({
    budget: compactionBudget(
      getContextWindow(model),
      (reasoningOpts as { maxOutputTokens?: number }).maxOutputTokens ?? compatMaxOutputTokens,
    ),
    overheadTokens: Math.ceil((mainSystem.length + toolSchemaChars(tools)) / 4),
    systemMessages,
    historyTurns: history.length,
    compact: createCompactor({
      model: languageModel,
      systemMessages,
      isAnthropic,
      tools: hasTools ? tools : undefined,
      activeTools: deferActive ? () => Array.from(activeToolNames) : undefined,
      callOptions,
      onCompacting,
    }),
    onReshaped: refreshVisibleReads,
    onPruneToolResults,
    onCompacted,
    signal,
  });

  const fitted = await context.fitHistory(messages, turnStarts);
  messages = fitted.messages;
  const promptState = fitted.reshaped ? scanInjectedState(messages) : injectedState;

  // ── This turn's injected context, after the cached history ───────────────
  const cacheAnchorIndex = messages.length - 1;
  context.setAnchor(cacheAnchorIndex);
  const injected = await buildTurnInjections({
    history,
    hooks,
    workspace,
    modelId,
    promptState,
    reminders: systemReminders,
    gitContext,
  });
  messages.push(...injected);
  context.setTurnStart(messages.length);

  recordPromptState({
    source: "main",
    systemBlocks,
    cacheIndex,
    tools: hasTools ? tools : undefined,
    model: model.id,
    effort: `${effort}${thinking ? "+think" : ""}`,
  });

  if (isAnthropic && cacheAnchorIndex >= 0) {
    messages[cacheAnchorIndex] = withCacheBreakpoint(messages[cacheAnchorIndex]);
  }

  // ── The model call ───────────────────────────────────────────────────────
  const st = newTurnStreamState();
  let arrivalChars = 0;
  let arrivalFirstAt = 0;
  let arrivalLastAt = 0;
  const onArrival = (chars: number) => {
    const now = Date.now();
    if (arrivalFirstAt === 0) arrivalFirstAt = now;
    arrivalLastAt = now;
    arrivalChars += chars;
  };

  const turnRepair = createToolCallRepair((name) => {
    if (deferActive && deferredNames.has(name)) activeToolNames.add(name);
  });

  const stepBreakpoint = isAnthropic && hasTools;
  const injectable = !!inbox && hasTools;
  const injectedSet = new Set<ModelMessage>();
  let injections: { at: number; msg: ModelMessage }[] = [];
  let passBase = 0;
  const withInjections = (base: ModelMessage[], offset: number): ModelMessage[] => {
    if (!injections.length) return base;
    const merged = [...base];
    let shift = 0;
    for (const inj of injections) {
      merged.splice(offset + inj.at + shift, 0, inj.msg);
      shift++;
    }
    return merged;
  };
  const takeInjections = (stepMessages: ModelMessage[]) => {
    const arrived = inbox!.take();
    if (!arrived.length) return;
    const at = stepMessages.length - passBase;
    for (const item of arrived) {
      const msg = toModelMessage({ role: "user", content: item.text, images: item.images }, allowImages);
      injectedSet.add(msg);
      injections.push({ at, msg });
    }
    inbox!.consumed(arrived);
  };
  // The last finished step's request size, from onStepFinish: the stream's reader can still be a
  // step behind when the next step is prepared, and relief would come a step late.
  let lastStepInput = 0;
  const prepareStep = async ({ messages: rawStepMessages, stepNumber }: { messages: ModelMessage[]; stepNumber: number }) => {
    const out: Record<string, unknown> = {};
    if (deferActive) out.activeTools = Array.from(activeToolNames);
    if (stepNumber === 0) passBase = rawStepMessages.length;
    else if (injectable) takeInjections(rawStepMessages);
    const stepMessages = withInjections(rawStepMessages, passBase);
    if (stepNumber > 0 && lastStepInput > context.budgetWindow * PRUNE_TRIGGER_RATIO) {
      await context.relieveStepPressure(stepMessages, lastStepInput);
    }
    const shaped = context.shape(stepMessages);
    if (stepBreakpoint && stepNumber > 0 && shaped.length > 0) {
      const copy = shaped === rawStepMessages ? [...shaped] : shaped;
      copy[copy.length - 1] = withCacheBreakpoint(copy[copy.length - 1]);
      out.messages = copy;
    } else if (shaped !== rawStepMessages) {
      out.messages = shaped;
    }
    return out;
  };
  const mergePass = (msgs: ModelMessage[]): ModelMessage[] => {
    const merged = withInjections(msgs, 0);
    injections = [];
    return merged;
  };
  const report = (msgs: ModelMessage[]) => {
    if (!onMessages) return;
    if (!injectedSet.size) {
      onMessages(msgs);
      return;
    }
    let segment: ModelMessage[] = [];
    let index = 0;
    for (const m of msgs) {
      if (!injectedSet.has(m)) {
        segment.push(m);
        continue;
      }
      if (segment.length) onMessages(segment, index);
      segment = [];
      index++;
    }
    if (segment.length) onMessages(segment, index);
  };

  let passSteps: ModelMessage[] = [];
  const buildStream = (msgs: ModelMessage[]) => {
    passSteps = [];
    st.stepText = "";
    return callModel({
      model: languageModel,
      messages: [...systemMessages, ...msgs],
      tools: hasTools ? tools : undefined,
      stopWhen: hasTools ? stepCountIs(maxSteps) : undefined,
      prepareStep,
      onStepFinish: (step) => {
        passSteps = step.response.messages;
        lastStepInput = step.usage?.inputTokens ?? lastStepInput;
        saveProgress();
      },
      repairToolCall: turnRepair,
      transform: uiSmoothing(onArrival),
      ...callOptions,
    });
  };

  const streamSinks: TurnStreamSinks = {
    emit,
    emitReasoning,
    endReasoningPhase: () => {
      reasonPhaseId = null;
    },
    mark,
    passthroughReasoning: isAnthropic,
    showDiagInUi: false,
    workspace: workspace ?? undefined,
    onTool,
    onUsage,
    onContext,
    onTodos,
    onPlan,
    onPreview,
    emitEvent,
    afterToolResult: async (call, output) => {
      await hooks.fire({
        hook_event_name: "PostToolUse",
        cwd: workspace ?? undefined,
        tool_name: call.name,
        tool_input: call.input,
        tool_response: output,
      });
    },
  };
  const processStream = (result: CallModelResult) => processTurnStream(result.fullStream, st, streamSinks);

  const diag = await getDiagnosticsRuntime();
  streamSinks.showDiagInUi = diag.showInUi;

  let convo: ModelMessage[] = [...messages];
  const turnMessages: ModelMessage[] = [...injected];
  /** The turn so far, kept on the reply after every step: a turn that fails or a closed app still
   *  leaves the model what was done, not the chat's text with its card markers. */
  function saveProgress() {
    if (!onMessages || stoppedSaved) return;
    try {
      report(applyToolResultPruning([...turnMessages, ...withInjections(passSteps, 0)], context.prune));
    } catch {
      /* best-effort */
    }
  }
  let stoppedSaved = false;
  /** The finished steps and what the step in progress had written, then why the turn ended there. */
  const persistStopped = (reason: string) => {
    if (stoppedSaved || !onMessages) return;
    stoppedSaved = true;
    const note = st.stepText.trim() ? `${st.stepText.trimEnd()}\n\n${reason}` : reason;
    try {
      report(applyToolResultPruning([...turnMessages, ...mergePass(passSteps), { role: "assistant", content: note }], context.prune));
    } catch {
      /* best-effort */
    }
  };
  const persistInterrupted = () =>
    persistStopped(st.stepText.trim() ? "[The user interrupted this reply here.]" : "[The user interrupted this turn here.]");
  const persistFailed = (err: unknown) => {
    const message = (err instanceof Error ? err.message : streamErrorMessage(err)).slice(0, 500);
    persistStopped(`[This turn stopped here with an error: ${message}]`);
  };
  const persistEnded = (err: unknown) => (signal?.aborted ? persistInterrupted() : persistFailed(err));
  setSettingsPollPaused(true);
  let result = buildStream(convo);
  try {
    let overflowRetries = 0;
    let transientRetried = false;
    for (;;) {
      const emittedBefore = full.length;
      const stepsBefore = st.stepCount;
      try {
        await processStream(result);
        break;
      } catch (err) {
        if (signal?.aborted) {
          persistInterrupted();
          throw err;
        }
        const untouched = full.length === emittedBefore && st.stepCount === stepsBefore;
        if (overflowRetries < MAX_OVERFLOW_RETRIES && isContextOverflowError(err)) {
          overflowRetries++;
          // The steps this pass already took stay: the next pass goes on from them rather than
          // starting the turn over, and relief can summarize them too.
          const done = mergePass(passSteps);
          passSteps = [];
          convo = [...convo, ...done];
          turnMessages.push(...done);
          if (!(await context.forceRelief(convo))) {
            persistFailed(err);
            throw err;
          }
        } else if (!transientRetried && untouched && isTransientStreamError(err)) {
          transientRetried = true;
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          persistFailed(err);
          throw err;
        }
        if (injections.length) {
          const carried = injections.map((i) => i.msg);
          injections = [];
          convo = [...convo, ...carried];
          turnMessages.push(...carried);
        }
        result = buildStream(convo);
      }
    }
  } finally {
    setSettingsPollPaused(false);
  }

  // ── Out of output tokens while only thinking: run that step again once, asking it to act.
  // Never more than once, so a model that always thinks past the limit can't loop.
  let outputLimitRetried = false;
  if (!signal?.aborted && st.finishReason === "length" && !st.lastStepActed) {
    let resp: { messages: ModelMessage[] } | null;
    try {
      resp = (await result.response) as { messages: ModelMessage[] };
    } catch {
      resp = null;
    }
    if (resp) {
      outputLimitRetried = true;
      // The earlier steps of the pass stay; the thought-only one gives way to its retry.
      const kept = withoutThoughtOnlyTail(mergePass(resp.messages));
      const retryUser: ModelMessage = { role: "user", content: buildOutputLimitRetryPrompt(st.lastStepReasoning) };
      turnMessages.push(...kept);
      convo = [...convo, ...kept, retryUser];
      emit("\n\n");
      result = buildStream(convo);
      try {
        await processStream(result);
      } catch (err) {
        persistEnded(err);
        throw err;
      }
    }
  }

  // ── Auto-fix: one more pass per round while edited files still have checker errors
  let fixPass = 0;
  while (
    diag.autoFix &&
    hasTools &&
    !signal?.aborted &&
    st.finishReason === "stop" &&
    st.editedDiag.size > 0 &&
    fixPass < diag.maxAttempts
  ) {
    fixPass++;
    let resp: { messages: ModelMessage[] };
    try {
      resp = (await result.response) as { messages: ModelMessage[] };
    } catch {
      break;
    }
    const synthUser: ModelMessage = {
      role: "user",
      content: buildAutoFixPrompt([...st.editedDiag.entries()]),
    };
    const merged = mergePass(resp.messages);
    turnMessages.push(...merged, synthUser);
    convo = [...convo, ...merged, synthUser];
    emit("\n\n");
    result = buildStream(convo);
    try {
      await processStream(result);
    } catch (err) {
      persistEnded(err);
      throw err;
    }
  }

  let finalResp: { messages: ModelMessage[] } | null;
  try {
    finalResp = (await result.response) as { messages: ModelMessage[] };
  } catch {
    finalResp = null;
  }
  const finalMerged = finalResp ? mergePass(finalResp.messages) : [];
  turnMessages.push(...finalMerged);
  // Those are the pass's steps: a stop from here on must not save them again.
  if (finalResp) passSteps = [];

  // ── Step limit reached: a closing pass with inert tools summarizes the state
  if (!signal?.aborted && st.finishReason === "tool-calls" && finalResp) {
    try {
      const closingHistory = [...convo, ...finalMerged];
      if (isAnthropic && closingHistory.length) {
        closingHistory[closingHistory.length - 1] = withCacheBreakpoint(closingHistory[closingHistory.length - 1]);
      }
      const closing = callModel({
        model: languageModel,
        messages: [...context.shape([...systemMessages, ...closingHistory]), { role: "user", content: STEP_LIMIT_PROMPT }],
        tools: inertTools(tools),
        ...(deferActive ? { activeTools: Array.from(activeToolNames) } : {}),
        stopWhen: stepCountIs(1),
        transform: uiSmoothing(),
        ...callOptions,
      });
      emit("\n\n");
      let closingText = "";
      for await (const delta of closing.textStream) {
        closingText += delta;
        emit(delta);
      }
      // The next turn's model sees where the work stood, as the user did.
      if (closingText.trim()) turnMessages.push({ role: "assistant", content: closingText });
    } catch {
      // Best-effort: if the closing pass fails, fall through with what we have.
    }
  }

  // ── Persist and report ───────────────────────────────────────────────────
  if (signal?.aborted) persistInterrupted();
  else if (onMessages && turnMessages.length > injected.length) {
    try {
      report(applyToolResultPruning(turnMessages, context.prune));
    } catch {
      // Best-effort: if persistence fails, skip.
    }
  }

  const cut = st.finishReason === "length";
  if (!signal?.aborted && (cut || outputLimitRetried)) {
    const ownLimit = (reasoningOpts as { maxOutputTokens?: number }).maxOutputTokens === undefined;
    onOutputLimit?.({
      cut,
      retried: outputLimitRetried,
      ...(needsExplicitMaxOutput && ownLimit ? { limit: compatMaxOutputTokens } : {}),
    });
  }

  const stats = turnCacheStats(st, model);
  onCacheStats?.(stats);
  if (import.meta.env?.DEV && (st.cacheReadTokens || st.cacheCreateTokens)) {
    const pct = st.totalInputTokens ? Math.round((st.cacheReadTokens / st.totalInputTokens) * 100) : 0;
    console.debug(
      `[prompt-cache] read ${st.cacheReadTokens} / written ${st.cacheCreateTokens} / input ${st.totalInputTokens} tokens (${pct}% from cache)`,
    );
  }

  if (!signal?.aborted) {
    await hooks.fire({ hook_event_name: "Stop", cwd: workspace ?? undefined });
  }

  if (timingEnabled()) {
    reportTurnTiming({
      marks,
      totalMs: Date.now() - turnStart,
      modelId: model.id,
      outputTokens: st.outputTokens,
      reasoningChars: st.reasoningChars,
      textChars: st.textChars,
      steps: st.stepCount,
      promptChars: mainSystem.length,
      toolChars: hasTools ? toolPromptChars(tools) : 0,
      arrivalChars,
      arrivalMs: arrivalLastAt > arrivalFirstAt ? arrivalLastAt - arrivalFirstAt : 0,
    });
  }

  return full;
}
