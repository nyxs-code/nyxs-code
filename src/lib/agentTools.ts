import type { ToolSet } from "ai";
import { isAutoApprovableReadOnly } from "@/lib/bashSafety";
import { lspConfig } from "@/lib/lsp";
import { ragConfig } from "@/lib/rag";
import { computerUseEnabled, musicToolEnabled } from "@/lib/featureSettings";
import { getMergedSnapshot } from "@/lib/settingsRuntime";
import { addAgentTools } from "@/tools/Agent/tool";
import { APPLY_PATCH_TOOL_NAME, createApplyPatchTool } from "@/tools/ApplyPatch/tool";
import { addAskUserQuestionTools } from "@/tools/AskUserQuestion/tool";
import { addBrowserTools } from "@/tools/Browser/tool";
import { createBashTool, createBashOutputTool, createKillShellTool } from "@/tools/Bash/tool";
import { createComputerTool } from "@/tools/Computer/tool";
import { createEditTool, createMultiEditTool } from "@/tools/Edit/tool";
import { createGitStatusTool, createGitDiffTool, createGitLogTool, createGitBlameTool } from "@/tools/Git/tool";
import { createGlobTool } from "@/tools/Glob/tool";
import { createGrepTool } from "@/tools/Grep/tool";
import { createListDirTool } from "@/tools/ListDir/tool";
import { addLspTools } from "@/tools/Lsp/tool";
import { createReadPdfTool, createWritePdfTool } from "@/tools/Pdf/tool";
import { createPreviewTool } from "@/tools/Preview/tool";
import { createReadTool } from "@/tools/Read/tool";
import { addRequestPermissionTools } from "@/tools/RequestPermission/tool";
import { addRetrieveContextTools } from "@/tools/RetrieveContext/tool";
import { addSessionSearchTools } from "@/tools/SessionSearch/tool";
import { addSessionTools } from "@/tools/Sessions/tool";
import { addSkillTools } from "@/tools/Skill/tool";
import { createTodoWriteTool } from "@/tools/TodoWrite/tool";
import { addVideoTools } from "@/tools/Video/tool";
import { videoCallReadOnly, videoEditToolNames, videoToolFor } from "@/lib/videoTools";
import { createWatchVideoTool } from "@/tools/WatchVideo/tool";
import { createMusicTool } from "@/tools/Music/tool";
import { createWebFetchTool } from "@/tools/WebFetch/tool";
import { createWebSearchTool } from "@/tools/WebSearch/tool";
import { createWriteTool } from "@/tools/Write/tool";
import { createWritePlanTool } from "@/tools/WritePlan/tool";
import { createToolContext, type BuildToolsOptions } from "@/tools/context";

export type { BuildToolsOptions, ToolContext, ContentExtractor } from "@/tools/context";
export { truncatedToolCalls, CONTENT_WRITE_TOOLS } from "@/tools/Write/truncated";
export { APPLY_PATCH_TOOL_NAME, usesApplyPatch } from "@/tools/ApplyPatch/tool";
export type { AgentPathScope } from "@/tools/paths";
export { formatRunResult } from "@/tools/Bash/format";
export { formatReadRange, readImageModelOutput } from "@/tools/Read/format";
export type { FileRange, ReadImageOutput } from "@/tools/Read/format";
export { toOneBasedPositions } from "@/tools/Lsp/positions";
export { gateToolSet } from "@/tools/gate";
export type { PermissionGate } from "@/tools/gate";
export type { AskOption, AskQuestion, AskAnswer, AskUserFn } from "@/tools/AskUserQuestion/types";
export { SUBAGENT_TYPES, DEFAULT_SUBAGENT_TYPE, resolveSubagentType } from "@/tools/Agent/types";
export type { SubagentDef, SubagentRunner } from "@/tools/Agent/types";
export { OUTPUT_PREVIEW_TOOLS, previewToolOutput, parseDiagnosticsBlock, buildToolDetail, describeToolCall, patchFileStats } from "@/lib/toolDetail";
export type { ToolCallLabel, DiffLine, Todo, ToolDetail, FileEditTracker } from "@/lib/toolDetail";

export function buildTools(toolOptions: BuildToolsOptions): ToolSet {
  const ctx = createToolContext(toolOptions);
  const { workspace, skills, planMode, gate, runSubagent, askUser, confirmBeforeWrite } = ctx;
  const tools: ToolSet = {
    Read: createReadTool(ctx),
    Write: createWriteTool(ctx),
    Edit: createEditTool(ctx),
    MultiEdit: createMultiEditTool(ctx),
    TodoWrite: createTodoWriteTool(),
    WritePlan: createWritePlanTool(ctx),
    Preview: createPreviewTool(),
    Glob: createGlobTool(ctx),
    Grep: createGrepTool(ctx),
    Bash: createBashTool(ctx),
    BashOutput: createBashOutputTool(ctx),
    KillShell: createKillShellTool(ctx),
    ListDir: createListDirTool(ctx),
    ReadPdf: createReadPdfTool(ctx),
    WritePdf: createWritePdfTool(ctx),
    WatchVideo: createWatchVideoTool(ctx),
    WebFetch: createWebFetchTool(ctx),
    WebSearch: createWebSearchTool(ctx),
    GitStatus: createGitStatusTool(ctx),
    GitDiff: createGitDiffTool(ctx),
    GitLog: createGitLogTool(ctx),
    GitBlame: createGitBlameTool(ctx),
  };

  // GPT models get Codex's patch tool instead of the three exact-replacement ones.
  if (toolOptions.patchEdits) {
    delete tools.Write;
    delete tools.Edit;
    delete tools.MultiEdit;
    tools[APPLY_PATCH_TOOL_NAME] = createApplyPatchTool(ctx);
  }

  if ((getMergedSnapshot() as { allowPreview?: boolean }).allowPreview === false) {
    delete tools.Preview;
  } else if (workspace) {
    addBrowserTools(tools, ctx);
  }

  // Off unless the user turns it on: it drives their real mouse and keyboard. Windows and macOS.
  if (computerUseEnabled()) {
    tools.Computer = createComputerTool(ctx);
  }

  if (musicToolEnabled()) tools.Music = createMusicTool();

  if (gate) addRequestPermissionTools(tools, ctx);

  if (askUser) addAskUserQuestionTools(tools, ctx);

  if (runSubagent) addAgentTools(tools, ctx);

  if (skills.length > 0) addSkillTools(tools, ctx);

  if (ragConfig().enabled) addRetrieveContextTools(tools, ctx);

  if (lspConfig().enabled && workspace) addLspTools(tools, ctx);

  addSessionSearchTools(tools, ctx);

  if (workspace) addVideoTools(tools, ctx);

  if (ctx.sessionKey) addSessionTools(tools, ctx);

  if (planMode) blockInPlanMode(tools);
  if (!confirmBeforeWrite && tools.RequestPermission) skipRequestPermission(tools);

  return sortToolSet(tools);
}

export const PLAN_MODE_BLOCKED_TOOLS = new Set(["Write", "Edit", "MultiEdit", APPLY_PATCH_TOOL_NAME, "WritePdf", "KillShell", ...videoEditToolNames()]);

export function planModeBlockMessage(toolName: string): string {
  return `${toolName} is blocked: plan mode is active, so nothing in the project may change yet. Keep investigating with read-only tools and present the plan with WritePlan.`;
}

function blockInPlanMode(tools: ToolSet): void {
  for (const name of Object.keys(tools)) {
    const t = tools[name];
    const run = t.execute;
    if (!run) continue;
    if (name === "VideoBatch") {
      // A batch of only reads changes nothing, so it stays usable like the reads themselves.
      const def = videoToolFor(name);
      tools[name] = {
        ...t,
        execute: async (input: unknown, options: Parameters<typeof run>[1]) => (def && videoCallReadOnly(def, input) ? run(input, options) : planModeBlockMessage(name)),
      };
    } else if (PLAN_MODE_BLOCKED_TOOLS.has(name)) {
      tools[name] = { ...t, execute: async () => planModeBlockMessage(name) };
    } else if (name === "Bash") {
      tools[name] = {
        ...t,
        execute: async (input: unknown, options: Parameters<typeof run>[1]) => {
          const command = String((input as { command?: unknown })?.command ?? "");
          if (!isAutoApprovableReadOnly(command)) {
            return `Bash is limited to read-only commands in plan mode (listing, reading, searching, git status/log/diff). This command was not run: ${command.slice(0, 200)}`;
          }
          return run(input, options);
        },
      };
    }
  }
}

function skipRequestPermission(tools: ToolSet): void {
  const t = tools.RequestPermission;
  tools.RequestPermission = {
    ...t,
    execute: async () => "Ask-first mode is off, so no approval is needed. Go ahead with the action.",
  };
}

export function sortToolSet(tools: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const name of Object.keys(tools).sort()) out[name] = tools[name];
  return out;
}
