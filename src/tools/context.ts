import { invoke } from "@/lib/ipc";
import { claudeMemoryDir } from "@/lib/claudeMemoryDir";
import { runDiagnosticsForFile, relativeTo } from "@/lib/diagnostics";
import { isRemotePath } from "@/lib/remote";
import { formatAfterEdit } from "@/lib/formatters";
import { newToolSession, type ToolSession } from "@/lib/fileStateCache";
import { lspConfig, lspDiagnosticsForFile, isLspSupported } from "@/lib/lsp";
import type { SkillDef } from "@/lib/skills";
import { isVideoTimelinePath, timelineDiagnostics } from "@/lib/video/timelineDiagnostics";
import type { FileEditTracker } from "@/lib/toolDetail";
import type { SubagentDef, SubagentRunner } from "@/tools/Agent/types";
import type { AskUserFn } from "@/tools/AskUserQuestion/types";
import { commandLogRoots } from "@/tools/Bash/format";
import { defaultToolPromptEnv, type ToolPromptEnv } from "@/tools/env";
import { isReadDenied, loadFileRules } from "@/lib/permissions";
import { settingsSnapshotFor } from "@/lib/settingsRuntime";
import { checkGate, type PermissionGate } from "@/tools/gate";
import { type AgentPathScope, normalizeRoots, resolvePath } from "@/tools/paths";

export interface BuildToolsOptions {
  workspace: string;
  skills?: SkillDef[];
  planMode?: boolean;
  gate?: PermissionGate;
  onFileEdit?: FileEditTracker;
  runSubagent?: SubagentRunner;
  subagentModels?: string[];
  askUser?: AskUserFn;
  promptEnv?: ToolPromptEnv;
  confirmBeforeWrite?: boolean;
  extraAgents?: SubagentDef[];
  allowPdf?: boolean;
  allowImages?: boolean;
  nativeToolImages?: boolean;
  /** The model's `videoModelKey` when it watches whole videos (`supportsVideo`); unset otherwise. */
  nativeVideo?: string;
  pathScope?: AgentPathScope;
  session?: ToolSession;
  extract?: ContentExtractor;
  recall?: (query: string, maxResults: number) => Promise<string>;
  /** The session's saved-environment variables, for the commands it runs. */
  env?: Record<string, string>;
  /** The session the tools run in (its chat id): the session tools tell it from the others. */
  sessionKey?: string;
  /** The chat whose built-in browser the browser tools drive; `sessionKey` when unset. Sub-agents
   *  get their parent's without becoming that session. */
  browserChat?: string;
  /** Files change through `apply_patch` instead of Write/Edit/MultiEdit (see usesApplyPatch). */
  patchEdits?: boolean;
}

export type ContentExtractor = (request: string, content: string, signal?: AbortSignal) => Promise<string | null>;

export function createToolContext(toolOptions: BuildToolsOptions) {
  const {
    workspace,
    skills = [],
    planMode = false,
    gate,
    onFileEdit,
    runSubagent,
    subagentModels = [],
    askUser,
    promptEnv = defaultToolPromptEnv(toolOptions.workspace),
    confirmBeforeWrite = false,
    extraAgents = [],
    allowPdf = false,
    allowImages = false,
    nativeToolImages = true,
    nativeVideo,
    pathScope,
    session = newToolSession(),
    extract,
    recall,
    env,
    sessionKey,
    browserChat = sessionKey,
  } = toolOptions;
  const scope = pathScope?.id ?? workspace;
  const extraRoots = normalizeRoots(pathScope?.extraRoots ?? []);
  const resolve = (p: string): string => resolvePath(p, workspace, extraRoots);
  // Reading also reaches Claude Code's memory for this project, whose files the prompt points at;
  // it is a folder of this PC, so not for a remote project.
  const resolveRead = (p: string): string => {
    const memory = isRemotePath(workspace) ? undefined : claudeMemoryDir(workspace);
    return resolvePath(p, workspace, [...extraRoots, ...commandLogRoots, ...normalizeRoots(memory ? [memory] : [])]);
  };

  /** What the permission gate gets for a file: the path as the model wrote it, where it
   *  resolves and where that is in the project, so a rule matches it however it was written. */
  const pathInput = (raw: string, abs: string, directory = false) => ({
    file_path: raw,
    resolved_path: abs,
    project_path: relativeTo(workspace, abs),
    ...(directory ? { directory: true } : {}),
  });
  /** Asks the gate whether the model may read a file or folder, under Read's rules whatever tool
   *  reads it (as Claude Code does); null when it may, or why not. */
  const gateRead = (raw: string, abs: string, directory = false): Promise<string | null> =>
    checkGate(gate, "Read", pathInput(raw, abs, directory));
  /** Whether a deny rule hides a file a search found. */
  // The rules of the turn's own folder, which may not be the one open in the app.
  const readDenied = (abs: string): boolean => isReadDenied(pathInput(abs, abs), loadFileRules(settingsSnapshotFor(workspace).merged));

  const trackEdit = async (path: string): Promise<void> => {
    if (!onFileEdit) return;
    try {
      await onFileEdit(path);
    } catch {
      // Ignore: a missing backup just means this file can't be reverted.
    }
  };

  const { fileState, visibleReads } = session;

  const guardStaleEdit = async (abs: string, tool: string): Promise<{ blocked: string } | { expectedMtime?: number }> => {
    let mtime: number | null;
    try {
      mtime = await invoke<number | null>("agent_file_mtime", { path: abs });
    } catch {
      return {};
    }
    if (mtime == null) return {};
    const prev = fileState.get(abs);
    if (!prev) {
      return {
        blocked:
          `${tool} blocked: you haven't read ${abs} in this session, so this change could ` +
          `overwrite content you haven't seen. Read it first, then ${tool} again.`,
      };
    }
    if (prev.mtime !== mtime) {
      return {
        blocked:
          `${tool} blocked: ${abs} changed on disk since you last read it (an external edit). ` +
          `Read it again so your change applies to the current version, then ${tool}.`,
      };
    }
    return { expectedMtime: mtime };
  };

  const recordWrite = async (abs: string, size: number): Promise<void> => {
    try {
      const mtime = await invoke<number | null>("agent_file_mtime", { path: abs });
      if (mtime != null) fileState.set(abs, { ...fileState.get(abs), mtime, size });
    } catch {
      // Best-effort: a missing refresh just means the next edit re-reads.
    }
  };

  const withDiagnostics = async (output: string, absPath: string): Promise<string> => {
    if (planMode) return output;
    let result = output;
    const formatter = await formatAfterEdit(workspace, absPath).catch(() => null);
    if (formatter) {
      await recordWrite(absPath, 0);
      result += `\n\n[${formatter} reformatted the file after this change; Read it again before editing the same lines.]`;
    }
    // A Nyxs Video timeline has no linter; its schema errors are what the model needs back.
    if (isVideoTimelinePath(absPath)) {
      const text = await invoke<string | null>("agent_read_text", { path: absPath, scope }).catch(() => null);
      const diag = text == null ? null : timelineDiagnostics(text, relativeTo(workspace, absPath) ?? absPath);
      return diag ? `${result}\n\n${diag}` : result;
    }
    if (lspConfig().enabled && isLspSupported(absPath)) {
      const rel = relativeTo(workspace, absPath);
      if (rel !== null) {
        try {
          const lsp = await lspDiagnosticsForFile(workspace, absPath, rel);
          if (lsp.handled) return lsp.block ? `${result}\n\n${lsp.block}` : result;
        } catch {
          // Cae al CLI fallback.
        }
      }
    }
    const diag = await runDiagnosticsForFile(workspace, absPath);
    return diag ? `${result}\n\n${diag}` : result;
  };

  const bgOffsets = new Map<string, number>();
  return {
    workspace,
    skills,
    planMode,
    gate,
    onFileEdit,
    runSubagent,
    subagentModels,
    askUser,
    promptEnv,
    confirmBeforeWrite,
    extraAgents,
    allowPdf,
    allowImages,
    nativeToolImages,
    nativeVideo,
    pathScope,
    session,
    extract,
    recall,
    env,
    sessionKey,
    browserChat,
    scope,
    resolve,
    resolveRead,
    pathInput,
    gateRead,
    readDenied,
    trackEdit,
    fileState,
    visibleReads,
    guardStaleEdit,
    recordWrite,
    withDiagnostics,
    bgOffsets,
  };
}

export type ToolContext = ReturnType<typeof createToolContext>;
