import { invoke } from "@/lib/ipc";
import { diffLines, structuredPatch } from "diff";
import { stripAnsi } from "@/lib/ansi";
import { browserToolFor, describeBrowserCall } from "@/lib/browserTools";
import { sessionToolFor } from "@/lib/sessionTools";
import { decisionOf, type Decision } from "@/lib/projects/projectTools";
import { describeVideoCall, videoToolFor } from "@/lib/videoTools";
import { parseMcpToolName } from "@/lib/mcp";
import { parsePatch, patchPaths, type PatchOp } from "@/tools/ApplyPatch/parse";
import { resolvePath } from "@/tools/paths";

export interface ToolCallLabel {
  name: string;
  detail: string;
}

export interface DiffLine {
  type: "add" | "del" | "context" | "hunk";
  text: string;
  /** The line's number: in the new file for an added line, the old file otherwise. */
  ln?: number;
  /** A context line's number in the new file, where edits above it shift it from `ln`. */
  newLn?: number;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface ToolDetail {
  name: string;
  detail: string;
  added?: number;
  removed?: number;
  diff?: DiffLine[];
  diagnostics?: string;
  diagnosticsTool?: string;
  streaming?: boolean;
  streamBytes?: number;
  streamLines?: number;
  streamStart?: number;
  output?: string;
  outputTruncated?: boolean;
  /** An image the chip shows as a thumbnail (VideoStill / VideoRender), an absolute path. */
  thumbnail?: string;
  /** The running tool's latest status line (see toolProgress.ts). */
  progress?: string;
  startedAt?: number;
  endedAt?: number;
  /** A command Nyxs stopped for using far more memory than the computer has (commandMemory.ts). */
  memoryStop?: { usedGb: number; installedGb: number };
  /** A command that moved to the background and goes on as this shell (commandBackground.ts);
   *  `limitMs` when its time limit moved it. */
  background?: { shellId: string; limitMs?: number };
  /** AskDecision: the question and its options, and the one the user picked once they did. */
  decision?: Decision & { chosen?: string };
}

export const OUTPUT_PREVIEW_TOOLS = new Set(["Bash", "BashOutput", "Grep", "Glob"]);

export const PREVIEW_EDGE_LINES = 30;

export const PREVIEW_MAX_CHARS = 6000;

export function previewToolOutput(text: string): { output: string; outputTruncated: boolean } {
  const lines = stripAnsi(text).replace(/\s+$/, "").split(/\r?\n/);
  let truncated = false;
  let kept = lines;
  if (lines.length > PREVIEW_EDGE_LINES * 2 + 1) {
    truncated = true;
    const omitted = lines.length - PREVIEW_EDGE_LINES * 2;
    kept = [...lines.slice(0, PREVIEW_EDGE_LINES), `… ${omitted} …`, ...lines.slice(-PREVIEW_EDGE_LINES)];
  }
  let output = kept.join("\n");
  if (output.length > PREVIEW_MAX_CHARS) {
    truncated = true;
    const half = PREVIEW_MAX_CHARS / 2;
    output = `${output.slice(0, half)}\n…\n${output.slice(-half)}`;
  }
  return { output, outputTruncated: truncated };
}

export function parseDiagnosticsBlock(output: string): { tool: string; body: string } | null {
  const m = output.match(/<diagnostics\b[^>]*\btool="([^"]*)"[^>]*>\n?([\s\S]*?)<\/diagnostics>/);
  if (!m) return null;
  const tool = m[1] || "diagnostics";
  let inner = m[2] ?? "";
  const sep = inner.indexOf("\n\n");
  if (sep !== -1) inner = inner.slice(sep + 2);
  const body = inner.trim();
  return body ? { tool, body } : null;
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export const CONTEXT_LINES = 3;

export const AMPERSAND_TOKEN = "<<:AMPERSAND_TOKEN:>>";

export const DOLLAR_TOKEN = "<<:DOLLAR_TOKEN:>>";

export const escapeForDiff = (s: string) => s.replaceAll("&", AMPERSAND_TOKEN).replaceAll("$", DOLLAR_TOKEN);

export const unescapeFromDiff = (s: string) => s.replaceAll(AMPERSAND_TOKEN, "&").replaceAll(DOLLAR_TOKEN, "$");

export function convertLeadingTabsToSpaces(content: string): string {
  if (!content.includes("\t")) return content;
  return content.replace(/^\t+/gm, (m) => "  ".repeat(m.length));
}

export async function readFileContents(path: string): Promise<string | null> {
  try {
    const raw = await invoke<string | null>("agent_read_text", { path });
    if (!raw) return null;
    return raw.replace(/\r\n/g, "\n").replace(/\n$/, "");
  } catch {
    return null;
  }
}

export interface FileEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export function buildPatchDiff(fileContents: string, edits: FileEdit[]): DiffLine[] | null {
  const prepared = escapeForDiff(convertLeadingTabsToSpaces(fileContents));
  const updated = edits.reduce((acc, edit) => {
    const oldStr = escapeForDiff(convertLeadingTabsToSpaces(edit.old_string));
    const newStr = escapeForDiff(convertLeadingTabsToSpaces(edit.new_string));
    return edit.replace_all ? acc.replaceAll(oldStr, () => newStr) : acc.replace(oldStr, () => newStr);
  }, prepared);

  const patch = structuredPatch("file", "file", prepared, updated, undefined, undefined, {
    context: CONTEXT_LINES,
  });
  if (!patch.hunks.length) return null;

  const diff: DiffLine[] = [];
  patch.hunks.forEach((hunk, hi) => {
    if (hi > 0) diff.push({ type: "hunk", text: "⋯" });
    let oldLn = hunk.oldStart;
    let newLn = hunk.newStart;
    for (const raw of hunk.lines) {
      const marker = raw[0];
      const text = unescapeFromDiff(raw.slice(1));
      if (marker === "+") {
        diff.push({ type: "add", text, ln: newLn++ });
      } else if (marker === "-") {
        diff.push({ type: "del", text, ln: oldLn++ });
      } else {
        diff.push({ type: "context", text, ln: oldLn++, newLn: newLn++ });
      }
    }
  });
  return diff;
}

export function diffStatsOf(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}

/** A real line diff of one replacement. Counting every line of old_string as removed and every
 *  line of new_string as added inflated the numbers by the unchanged context the model quotes. */
function lineDiff(oldText: string, newText: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const change of diffLines(oldText.replace(/\r\n/g, "\n"), newText.replace(/\r\n/g, "\n"))) {
    const type = change.added ? "add" : change.removed ? "del" : "context";
    for (const text of splitLines(change.value)) out.push({ type, text });
  }
  return out;
}

/** Claude Code's own diff of an edit it applied (tool_use_result.structuredPatch). It is exact,
 *  unlike anything rebuilt from the input after the file may already have changed. */
export function diffFromStructuredPatch(patch: unknown): DiffLine[] | null {
  if (!Array.isArray(patch) || !patch.length) return null;
  const diff: DiffLine[] = [];
  patch.forEach((hunk, hi) => {
    const h = (hunk ?? {}) as { oldStart?: number; newStart?: number; lines?: unknown };
    if (!Array.isArray(h.lines)) return;
    if (hi > 0) diff.push({ type: "hunk", text: "⋯" });
    let oldLn = Number(h.oldStart) || 1;
    let newLn = Number(h.newStart) || 1;
    for (const raw of h.lines) {
      if (typeof raw !== "string") continue;
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === "+") diff.push({ type: "add", text, ln: newLn++ });
      else if (marker === "-") diff.push({ type: "del", text, ln: oldLn++ });
      else if (marker === " ") diff.push({ type: "context", text, ln: oldLn++, newLn: newLn++ });
    }
  });
  return diff.length ? diff : null;
}

/** The file and line counts of an edit Claude Code applied, from its tool_use_result: Edit and
 *  MultiEdit carry `structuredPatch`, Write `type: "create" | "update"` with the same patch (empty
 *  for a new file, whose lines are its content). Null for anything that isn't a file edit. */
export function editStatsOfResult(result: unknown): { path: string; added: number; removed: number } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { filePath?: unknown; structuredPatch?: unknown; type?: unknown; content?: unknown; oldString?: unknown };
  if (typeof r.filePath !== "string" || !r.filePath) return null;
  const patch = diffFromStructuredPatch(r.structuredPatch);
  if (patch) return { path: r.filePath, ...diffStatsOf(patch) };
  if (r.type === "create" && typeof r.content === "string") return { path: r.filePath, added: splitLines(r.content).length, removed: 0 };
  // An edit or overwrite that left the file as it was.
  if (Array.isArray(r.structuredPatch) && (r.type === "update" || "oldString" in r)) return { path: r.filePath, added: 0, removed: 0 };
  return null;
}

/** Each file an apply_patch call changes, with its line counts (a deleted file counts none). */
export function patchFileStats(patch: string): { path: string; added: number; removed: number }[] {
  let ops: PatchOp[];
  try {
    ops = parsePatch(patch);
  } catch {
    return [];
  }
  return ops.map((op) => {
    if (op.type === "add") return { path: op.path, added: splitLines(op.content).length, removed: 0 };
    if (op.type === "delete") return { path: op.path, added: 0, removed: 0 };
    const stats = diffStatsOf(op.hunks.flatMap((h) => lineDiff(h.oldLines.join("\n"), h.newLines.join("\n"))));
    return { path: op.moveTo ?? op.path, ...stats };
  });
}

export async function buildToolDetail(
  toolName: string,
  input: unknown,
  workspace?: string,
): Promise<ToolDetail> {
  const { name, detail } = describeToolCall(toolName, input);
  const i = (input ?? {}) as Record<string, unknown>;

  if (toolName === "Edit" || toolName === "MultiEdit") {
    const edits: FileEdit[] =
      toolName === "Edit"
        ? [{ old_string: String(i.old_string ?? ""), new_string: String(i.new_string ?? ""), replace_all: Boolean(i.replace_all) }]
        : (Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : []).map((e) => ({
            old_string: String(e.old_string ?? ""),
            new_string: String(e.new_string ?? ""),
            replace_all: Boolean(e.replace_all),
          }));

    let diff = edits.flatMap((e, idx) => [...(idx > 0 ? [{ type: "hunk" as const, text: "⋯" }] : []), ...lineDiff(e.old_string, e.new_string)]);
    if (workspace) {
      const contents = await readFileContents(resolvePath(String(i.file_path ?? ""), workspace));
      const patch = contents !== null ? buildPatchDiff(contents, edits) : null;
      if (patch) diff = patch;
    }
    return { name, detail, ...diffStatsOf(diff), diff };
  }

  if (toolName === "apply_patch") {
    let ops: PatchOp[];
    try {
      ops = parsePatch(String(i.input ?? ""));
    } catch {
      return { name, detail };
    }
    const diff: DiffLine[] = [];
    // A deleted file adds no lines: the card's path list says it was touched.
    for (const op of ops) {
      if (op.type === "delete") continue;
      if (diff.length) diff.push({ type: "hunk", text: "⋯" });
      if (op.type === "add") diff.push(...splitLines(op.content).map((text) => ({ type: "add" as const, text })));
      else op.hunks.forEach((h, idx) => diff.push(...(idx > 0 ? [{ type: "hunk" as const, text: "⋯" }] : []), ...lineDiff(h.oldLines.join("\n"), h.newLines.join("\n"))));
    }
    return { name, detail, ...diffStatsOf(diff), diff };
  }

  if (toolName === "Write") {
    const content = String(i.content ?? "");
    // Overwriting a file only changes what differs. If it was already written by the time we
    // read it (same content), there is nothing left to compare against: count it as new.
    if (workspace) {
      const contents = await readFileContents(resolvePath(String(i.file_path ?? ""), workspace));
      const next = content.replace(/\r\n/g, "\n").replace(/\n$/, "");
      const patch = contents !== null && contents !== next ? buildPatchDiff(contents, [{ old_string: contents, new_string: next }]) : null;
      if (patch) return { name, detail, ...diffStatsOf(patch), diff: patch };
    }
    const lines = splitLines(content);
    return { name, detail, added: lines.length, removed: 0, diff: lines.map((text) => ({ type: "add" as const, text })) };
  }

  // A project coordinator's question: the chat draws its options as a card under the call.
  if (name === "AskDecision") {
    const decision = decisionOf(input);
    if (decision) return { name, detail, decision };
  }

  return { name, detail };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** One line for a Computer call in the transcript: the action and what it acts on. */
export function describeComputerCall(i: Record<string, unknown>): string {
  const action = String(i.action ?? "");
  const xy = Array.isArray(i.coordinate) ? ` (${i.coordinate.join(", ")})` : "";
  const text = typeof i.text === "string" && i.text ? ` ${JSON.stringify(i.text.length > 60 ? `${i.text.slice(0, 60)}…` : i.text)}` : "";
  if (action === "scroll") return `scroll ${String(i.scroll_direction ?? "down")}${xy}`;
  if (action === "focus_window" || action === "get_window_state") return `${action} ${String(i.window_id ?? "")}`.trim();
  if (action === "click_element" || action === "set_value") return `${action} [${String(i.element_index ?? "")}]${text}`;
  return `${action}${text}${xy}`;
}

export function detectWebFetch(cmd: string): string | null {
  if (!/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(cmd)) return null;
  const url = /https?:\/\/[^\s"'`)]+/i.exec(cmd);
  return url ? url[0] : "";
}

export function describeToolCall(toolName: string, input: unknown): ToolCallLabel {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (v == null ? "" : String(v));
  switch (toolName) {
    case "Read":
      return { name: "Read", detail: str(i.file_path) };
    case "Write":
      return { name: "Write", detail: str(i.file_path) };
    case "Edit":
      return { name: "Edit", detail: str(i.file_path) };
    case "MultiEdit":
      return { name: "MultiEdit", detail: str(i.file_path) };
    // Shown as an edit, so the changes card and the trace count it like one.
    case "apply_patch":
      return { name: "Edit", detail: patchPaths(str(i.input)).join(", ") };
    case "Preview":
      return { name: "Preview", detail: str(i.path) };
    case "TodoWrite":
      return { name: "TodoWrite", detail: "" };
    case "Glob":
      return { name: "Glob", detail: str(i.pattern) };
    case "Grep":
      return { name: "Grep", detail: str(i.pattern) + (i.glob ? ` in ${str(i.glob)}` : "") };
    case "WebFetch":
      return { name: "WebFetch", detail: str(i.url) };
    case "WebSearch":
      return { name: "WebSearch", detail: str(i.query) };
    case "ReadPdf":
      return { name: "ReadPdf", detail: str(i.file_path) };
    case "WritePdf":
      return { name: "WritePdf", detail: str(i.file_path) };
    case "WatchVideo":
      return { name: "WatchVideo", detail: str(i.file_path) };
    case "VideoCreate":
      return { name: toolName, detail: str(i.name) };
    case "VideoStill": {
      const frames = Array.isArray(i.frames) ? i.frames.join(", ") : "";
      return { name: toolName, detail: frames ? `${str(i.project)} · ${frames}` : str(i.project) };
    }
    case "VideoRender":
    case "VideoOpen":
    case "VideoCaptions":
    case "VideoRemoveSilences":
    case "VideoImportMedia":
      return { name: toolName, detail: str(i.project) };
    case "VideoCutByTranscript": {
      const phrases = Array.isArray(i.phrases) ? i.phrases.map((p) => `"${String(p)}"`).join(", ") : "";
      return { name: toolName, detail: phrases ? `${str(i.project)} · ${phrases}` : str(i.project) };
    }
    case "Computer":
      return { name: "Computer", detail: describeComputerCall(i) };
    case "Bash": {
      const cmd = str(i.command);
      const web = detectWebFetch(cmd);
      if (web !== null) return { name: "WebSearch", detail: web };
      return { name: "Bash", detail: i.run_in_background ? `${cmd}  (background)` : cmd };
    }
    case "BashOutput":
      return { name: "BashOutput", detail: str(i.shell_id) };
    case "KillShell":
      return { name: "KillShell", detail: str(i.shell_id) };
    case "Monitor":
      return { name: "Monitor", detail: str(i.command) };
    case "ListDir":
      return { name: "ListDir", detail: str(i.path) };
    case "Skill":
      return { name: "Skill", detail: str(i.skill) + (i.args ? ` ${str(i.args)}` : "") };
    case "Agent":
      return { name: "Agent", detail: str(i.description) };
    case "retrieve_context":
      return { name: "retrieve_context", detail: str(i.query) };
    case "Workflow":
      return { name: "Workflow", detail: `${str(i.mode)}: ${str(i.task)}` };
    case "ToolSearch":
      return { name: "ToolSearch", detail: str(i.query) };
    case "Lsp":
      return {
        name: "Lsp",
        detail: `${str(i.action)} ${str(i.file_path)}`.trim(),
      };
    case "GitStatus":
      return { name: "GitStatus", detail: "" };
    case "GitDiff":
      return { name: "GitDiff", detail: str(i.path) || str(i.commit) || (i.staged ? "staged" : "") };
    case "GitLog":
      return { name: "GitLog", detail: str(i.path) };
    case "GitBlame":
      return { name: "GitBlame", detail: str(i.file_path) };
    case "TaskCreate":
      return { name: "TaskCreate", detail: str(i.description) };
    case "TaskList":
      return { name: "TaskList", detail: "" };
    case "TaskOutput":
      return { name: "TaskOutput", detail: str(i.task_id) };
    case "TaskStop":
      return { name: "TaskStop", detail: str(i.task_id) };
    case "RequestPermission":
      return { name: "RequestPermission", detail: str(i.summary) };
    // The chat shows a card for the session (see SessionCards), found by this title.
    case "CreateSession":
      return { name: "CreateSession", detail: str(i.title).trim() };
    // A project's thread: its card (see ThreadCards) is found by this title.
    case "StartThread":
      return { name: "StartThread", detail: str(i.title).trim() };
    case "AskDecision":
      return { name: "AskDecision", detail: str(i.question).trim() };
    case "Report":
      return { name: "Report", detail: str(i.status) || "review" };
    case "SendToSession":
    case "ReadSession":
    case "RenameSession":
    case "ArchiveSession":
      return { name: toolName, detail: str(i.title ?? i.session_id) };
    case "AskUserQuestion": {
      const qs = Array.isArray(i.questions) ? (i.questions as Record<string, unknown>[]) : [];
      const first = qs[0]?.question;
      return { name: "AskUserQuestion", detail: qs.length > 1 ? `${qs.length} preguntas` : str(first) };
    }
    default: {
      const browser = browserToolFor(toolName);
      if (browser) return { name: "Browser", detail: describeBrowserCall(browser, i) };
      const video = videoToolFor(toolName);
      if (video) return { name: "Video", detail: describeVideoCall(video, i) };
      // Claude Code's calls to Nyxs's own sessions server read like the built-in models' ones,
      // so a session it creates gets the same card.
      const session = sessionToolFor(toolName);
      if (session && session.name !== toolName) return describeToolCall(session.name, input);
      const mcp = parseMcpToolName(toolName);
      if (mcp) return { name: mcp.tool, detail: `${mcp.server} (MCP)` };
      return { name: toolName, detail: "" };
    }
  }
}

export type FileEditTracker = (absolutePath: string) => Promise<void>;
