import type { ModelMessage, ToolSet } from "ai";
import type { ChatMessage } from "@/components/Message";
import { buildTools, usesApplyPatch } from "./agentTools";
import type { ContextBreakdown, ContextCategory, ContextChild } from "./claudeCodeUsage";
import { compactionBudget } from "./contextBudget";
import { cachedMcpTools, isMcpServerConfigured, loadMergedMcpServers } from "./mcp";
import { estimateMessageTokens } from "./microcompact";
import { getContextWindow, supportsImages, type ModelInfo } from "./models";
import { getOutputStyle } from "./outputStyles";
import { cachedPreflight, EMPTY_PREFLIGHT, type PreflightBundle } from "./preflight";
import { getMergedSnapshot } from "./settingsRuntime";
import { buildSkillsListing, type SkillDef } from "./skills";
import { buildSystemPromptBlocks, modelFamilyOf } from "./systemPrompt";
import { DEFER_THRESHOLD } from "../tools/ToolSearch/prompt";
import { DEFER_LOCAL_TOOLS, toolSchemaChars } from "./turnSupport";

/** Nyxs' default max output, as in modelClient.ts's COMPAT_MAX_OUTPUT_TOKENS (kept apart so
 *  opening the panel doesn't pull the model providers in). */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

const charsToTokens = (chars: number): number => Math.ceil(chars / 4);

/** A tool's schema size, before it becomes a context row. */
export interface EstimateTool {
  name: string;
  chars: number;
}

/** A memory file's size, before it becomes a context row. */
export interface EstimateFile {
  name: string;
  chars: number;
}

/** The pieces the estimate is built from, all in chars (or whole tokens for the history). */
export interface ContextEstimateParts {
  window: number;
  /** What the provider reported as used by the last request; 0 before the first reply. */
  used: number;
  maxOutputTokens: number;
  systemPromptChars: number;
  /** Active system tools, one entry per schema (deferred ones are listed separately). */
  systemTools?: EstimateTool[];
  deferredSystemTools?: EstimateTool[];
  /** Fallback when per-tool sizes aren't available. */
  systemToolChars?: number;
  mcpTools?: EstimateTool[];
  deferredMcpTools?: EstimateTool[];
  /** Fallback when per-tool sizes aren't available. */
  mcpToolChars?: number;
  mcpInstructionsChars: number;
  memoryFiles?: EstimateFile[];
  /** Fallback when the files' own sizes aren't available. */
  memoryChars?: number;
  skillsChars: number;
  /** The history, for a chat whose provider hasn't reported a total yet. */
  messageTokens: number;
}

const toChildren = (items: EstimateTool[] | EstimateFile[] | undefined): ContextChild[] =>
  (items ?? [])
    .map((item) => ({ name: item.name, tokens: charsToTokens(item.chars) }))
    .filter((child) => child.tokens > 0);

const totals = (children: ContextChild[]): number => children.reduce((n, child) => n + child.tokens, 0);

const withChildren = (category: ContextCategory, children: ContextChild[]): ContextCategory =>
  children.length ? { ...category, children } : category;

/** Scales rows so they add up to the slice exactly (rounding per row would drift). */
function scaleChildren(children: ContextChild[], target: number): ContextChild[] {
  if (target <= 0) return [];
  const total = totals(children);
  if (total <= 0) return [];
  if (total === target) return children;
  let remaining = target;
  return children
    .map((child, i) => {
      const tokens = i === children.length - 1 ? remaining : Math.floor((child.tokens * target) / total);
      remaining -= tokens;
      return { ...child, tokens };
    })
    .filter((child) => child.tokens > 0);
}

function scaleCategory(category: ContextCategory, scale: number): void {
  category.tokens = Math.floor(category.tokens * scale);
  if (category.children?.length) category.children = scaleChildren(category.children, category.tokens);
}

/** A breakdown in the shape the panel understands. With a reported total, the conversation is
 *  derived as `used - overhead`, so the used slices add up to `used` exactly; without one, the
 *  history is estimated with `estimateMessageTokens` and the total is what all of it adds up to.
 *  Deferred rows are listed but never counted: their schemas aren't loaded into the window. */
export function estimateContextBreakdown(parts: ContextEstimateParts): ContextBreakdown {
  const systemChildren = toChildren(parts.systemTools);
  const mcpChildren = toChildren(parts.mcpTools);
  const memoryChildren = toChildren(parts.memoryFiles);
  const sliceTokens = (children: ContextChild[], fallbackChars = 0): number =>
    children.length ? totals(children) : charsToTokens(fallbackChars);

  let overhead: ContextCategory[] = [
    { id: "system-prompt", name: "System prompt", tokens: charsToTokens(parts.systemPromptChars), kind: "used" },
    withChildren(
      { id: "system-tools", name: "System tools", tokens: sliceTokens(systemChildren, parts.systemToolChars), kind: "used" },
      systemChildren,
    ),
    withChildren(
      { id: "mcp-tools", name: "MCP tools", tokens: sliceTokens(mcpChildren, parts.mcpToolChars), kind: "used" },
      mcpChildren,
    ),
    { id: "mcp-instructions", name: "MCP server instructions", tokens: charsToTokens(parts.mcpInstructionsChars), kind: "used" },
    withChildren(
      { id: "memory-files", name: "Memory files", tokens: sliceTokens(memoryChildren, parts.memoryChars), kind: "used" },
      memoryChildren,
    ),
    { id: "skills", name: "Skills", tokens: charsToTokens(parts.skillsChars), kind: "used" },
  ].filter((category) => category.tokens > 0);

  let overheadTokens = totals(overhead);
  let totalTokens: number;
  let messageTokens: number;
  if (parts.used > 0) {
    totalTokens = parts.used;
    // Settings can change after the last reply; never let the estimate outgrow what the provider
    // counted, or the free space would go negative.
    if (overheadTokens > totalTokens) {
      const scale = totalTokens / overheadTokens;
      for (const category of overhead) scaleCategory(category, scale);
      overhead = overhead.filter((category) => category.tokens > 0);
      overheadTokens = totals(overhead);
    }
    messageTokens = Math.max(0, totalTokens - overheadTokens);
  } else {
    messageTokens = parts.messageTokens;
    totalTokens = overheadTokens + messageTokens;
  }

  const categories = [...overhead];
  if (messageTokens > 0) categories.push({ id: "messages", name: "Messages", tokens: messageTokens, kind: "used" });

  const deferred: ContextCategory[] = [];
  const addDeferred = (id: string, name: string, items: EstimateTool[] | undefined) => {
    const children = toChildren(items);
    if (children.length) {
      deferred.push({ id, name, tokens: totals(children), kind: "deferred", children, estimated: true });
    }
  };
  addDeferred("system-tools-deferred", "System tools (deferred)", parts.deferredSystemTools);
  addDeferred("mcp-tools-deferred", "MCP tools (deferred)", parts.deferredMcpTools);
  categories.push(...deferred);

  const buffer = Math.max(0, parts.window - compactionBudget(parts.window, parts.maxOutputTokens).trigger);
  if (buffer > 0) {
    categories.push({ id: "autocompact-buffer", name: "Autocompact buffer", tokens: buffer, kind: "buffer" });
  }

  return { categories, totalTokens, maxTokens: parts.window, estimated: true };
}

interface PromptSettings {
  language?: unknown;
  outputStyle?: unknown;
  workflow?: { enabled?: boolean };
  generation?: { maxOutputTokens?: number };
  pullRequests?: { autoCreate?: boolean; autoFix?: boolean };
  toolAccessMode?: "onDemand" | "preloaded";
}

/** The messages this chat would send: each reply's own model messages when it has them. */
function conversationMessages(messages: ChatMessage[] | undefined): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages ?? []) {
    if (m.responseMessages?.length) out.push(...m.responseMessages);
    else out.push({ role: m.role, content: m.content } as ModelMessage);
  }
  return out;
}

const sectionChars = (blocks: string[]): number => blocks.join("\n\n").length;

/** Claude Code's MEMORY.md index, as the loaded-memory row the panel lists. */
function claudeMemoryFile(claudeMemory: string): EstimateFile[] {
  if (!claudeMemory.trim()) return [];
  const match = /^Folder: `([^`]+)`\n\n([\s\S]*)$/.exec(claudeMemory);
  const dir = (match?.[1] ?? "").replace(/[\\/]+$/, "");
  const index = match?.[2] ?? claudeMemory;
  const sep = dir.includes("\\") ? "\\" : "/";
  return [{ name: dir ? `${dir}${sep}MEMORY.md` : "MEMORY.md", chars: index.length }];
}

const bySize = (a: EstimateTool, b: EstimateTool): number => b.chars - a.chars;

interface EstimateParts {
  window: number;
  maxOutputTokens: number;
  systemPromptChars: number;
  skillsChars: number;
  memoryChars: number;
  mcpInstructionsChars: number;
  systemTools: EstimateTool[];
  deferredSystemTools: EstimateTool[];
  mcpTools: EstimateTool[];
  deferredMcpTools: EstimateTool[];
  memoryFiles: EstimateFile[];
}

/** Everything the estimate needs, from the prompt Nyxs would send and what is already cached:
 *  no file reads beyond the preflight cache and no MCP connection or other process. */
async function loadEstimateParts({ model, workspace }: { model: ModelInfo; workspace: string | null }): Promise<EstimateParts> {
  const merged = getMergedSnapshot() as unknown as PromptSettings;
  const preflight: PreflightBundle = workspace ? await cachedPreflight(workspace) : EMPTY_PREFLIGHT;
  const workflowEnabled = Boolean(merged.workflow?.enabled);
  const skills: SkillDef[] = workflowEnabled ? preflight.skills.filter((s) => s.name !== "review") : preflight.skills;
  const skillsListing = buildSkillsListing(skills);

  const mcpServers = loadMergedMcpServers().filter((s) => s.enabled && isMcpServerConfigured(s));
  // Same section agentTurn.ts adds for connected servers; their tools' schemas come from the
  // last read, so opening the panel never connects to them.
  const mcpInstructions = mcpServers.length
    ? `# MCP servers (external tools)
You are connected to these MCP servers. Their tools are named \`mcp__<server>__<tool>\`; use them when relevant to the task:
${mcpServers.map((s) => `- ${s.name}`).join("\n")}`
    : "";

  const patchEdits = usesApplyPatch(model.apiModel);
  const common = {
    workspace,
    planMode: false,
    outputStylePrompt: getOutputStyle(String(merged.outputStyle ?? "")).prompt,
    language: String(merged.language ?? ""),
    // Whether the folder is a git repo is only known by running git, which the panel must not do.
    gitRepo: Boolean(workspace),
    confirmBeforeWrite: false,
    autoPullRequest: merged.pullRequests?.autoCreate ?? false,
    autoFixPullRequest: merged.pullRequests?.autoFix ?? false,
    date: new Date().toISOString().slice(0, 10),
    leanReasoning: model.provider === "minimax-anthropic",
    modelFamily: modelFamilyOf(model.provider, model.apiModel),
    patchEdits,
  };
  const withoutExtras = { ...common, projectMemory: "", claudeMemory: "", mcpInstructions: "" };
  const base = buildSystemPromptBlocks({ ...withoutExtras, skillsListing: "" });
  const withSkills = skillsListing ? buildSystemPromptBlocks({ ...withoutExtras, skillsListing }) : base;
  const withMemory =
    preflight.memory || preflight.claudeMemory
      ? buildSystemPromptBlocks({
          ...withoutExtras,
          skillsListing: "",
          projectMemory: preflight.memory,
          claudeMemory: preflight.claudeMemory,
        })
      : base;
  const systemPromptChars = sectionChars(base);
  const skillsChars = Math.max(0, sectionChars(withSkills) - systemPromptChars);
  const memoryChars = Math.max(0, sectionChars(withMemory) - systemPromptChars);

  const cachedTools = cachedMcpTools(mcpServers, supportsImages(model));
  const mcpEstimate = cachedTools.map((tool) => ({ name: `${tool.server} · ${tool.name}`, chars: tool.chars }));
  // Same rule as deferTools(): MCP tools are deferred only in on-demand mode past the threshold.
  const deferMcp = (merged.toolAccessMode ?? "onDemand") === "onDemand" && mcpEstimate.length > DEFER_THRESHOLD;
  mcpEstimate.sort(bySize);

  const systemTools: EstimateTool[] = [];
  const deferredSystemTools: EstimateTool[] = [];
  if (workspace) {
    try {
      for (const [name, def] of Object.entries(buildTools({ workspace, skills, patchEdits }))) {
        const tool = { name, chars: toolSchemaChars({ [name]: def } as ToolSet) };
        (DEFER_LOCAL_TOOLS.has(name) ? deferredSystemTools : systemTools).push(tool);
      }
    } catch {
      // A tool catalog that can't be built just leaves these slices out.
    }
  }
  systemTools.sort(bySize);
  deferredSystemTools.sort(bySize);

  return {
    window: getContextWindow(model),
    maxOutputTokens: merged.generation?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    systemPromptChars,
    skillsChars,
    memoryChars,
    mcpInstructionsChars: mcpInstructions.length,
    systemTools,
    deferredSystemTools,
    mcpTools: deferMcp ? [] : mcpEstimate,
    deferredMcpTools: deferMcp ? mcpEstimate : [],
    memoryFiles: [
      ...(preflight.memoryFiles ?? []).map((file) => ({ name: file.name, chars: file.chars })),
      ...claudeMemoryFile(preflight.claudeMemory),
    ],
  };
}

/** An estimated breakdown for a provider that doesn't measure it (everything but Claude Code),
 *  from the prompt, tools and cached memory/skills Nyxs would send. */
export async function estimateProviderContext({
  model,
  workspace,
  used,
  messages,
}: {
  model: ModelInfo;
  workspace: string | null;
  used: number;
  messages: ChatMessage[] | undefined;
}): Promise<ContextBreakdown> {
  const parts = await loadEstimateParts({ model, workspace });
  return estimateContextBreakdown({
    window: parts.window,
    used,
    maxOutputTokens: parts.maxOutputTokens,
    systemPromptChars: parts.systemPromptChars,
    systemTools: parts.systemTools,
    deferredSystemTools: parts.deferredSystemTools,
    mcpTools: parts.mcpTools,
    deferredMcpTools: parts.deferredMcpTools,
    mcpInstructionsChars: parts.mcpInstructionsChars,
    memoryFiles: parts.memoryFiles,
    memoryChars: parts.memoryChars,
    skillsChars: parts.skillsChars,
    messageTokens: estimateMessageTokens(conversationMessages(messages)),
  });
}

/** Adds Nyxs' per-tool and per-file rows to a breakdown Claude Code measured. The totals and
 *  slice sizes are left exactly as the CLI reported them; only rows it didn't provide are
 *  filled in, and those are marked as estimated. */
export async function enrichMeasuredContext(
  measured: ContextBreakdown,
  { model, workspace }: { model: ModelInfo; workspace: string | null },
): Promise<ContextBreakdown> {
  if (measured.categories.length === 0) return measured;
  const parts = await loadEstimateParts({ model, workspace });
  const breakdown: ContextBreakdown = {
    ...measured,
    categories: measured.categories.map((category) => ({
      ...category,
      children: category.children?.map((child) => ({ ...child })),
    })),
  };

  const attach = (id: string, items: EstimateTool[] | EstimateFile[]) => {
    const category = breakdown.categories.find((c) => c.id === id);
    if (!category || category.children?.length) return;
    const children = toChildren(items);
    if (!children.length) return;
    category.children = scaleChildren(children, category.tokens);
    category.childrenEstimated = true;
  };
  attach("system-tools", parts.systemTools);
  attach("mcp-tools", parts.mcpTools);
  attach("memory-files", parts.memoryFiles);

  const addDeferred = (id: string, name: string, items: EstimateTool[]) => {
    if (breakdown.categories.some((c) => c.id === id)) return;
    const children = toChildren(items);
    if (!children.length) return;
    breakdown.categories.push({
      id,
      name,
      tokens: totals(children),
      kind: "deferred",
      children,
      estimated: true,
      childrenEstimated: true,
    });
  };
  addDeferred("system-tools-deferred", "System tools (deferred)", parts.deferredSystemTools);
  addDeferred("mcp-tools-deferred", "MCP tools (deferred)", parts.deferredMcpTools);

  return breakdown;
}
