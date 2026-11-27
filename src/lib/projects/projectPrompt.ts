import { projectById, projectMemory } from "./projectStore";
import { projectRoleOf } from "./projectDirectory";
import type { Project, ProjectRole } from "./types";

/** The project tools by their MCP name, with the built-in models' name. */
export const PROJECT_TOOL_NAMES = {
  start_thread: "StartThread",
  message_thread: "MessageThread",
  read_thread: "ReadThread",
  list_threads: "ListThreads",
  set_thread_status: "SetThreadStatus",
  ask_decision: "AskDecision",
  update_memory: "UpdateMemory",
  report: "Report",
} as const;

export type ProjectToolMcpName = keyof typeof PROJECT_TOOL_NAMES;

/** How the agent names a tool: the built-in models by their own name, a CLI by the MCP one
 *  (`mcpPrefix` "mcp__nyxs-sessions__" for Claude Code, "" when the server's own instructions
 *  name them). */
export type ToolNamer = (mcp: ProjectToolMcpName) => string;
export const builtinNamer: ToolNamer = (mcp) => PROJECT_TOOL_NAMES[mcp];
export const mcpNamer = (prefix: string): ToolNamer => (mcp) => `${prefix}${mcp}`;

function folders(p: Project): string {
  const lines = p.repos.map((r) => `- ${[r.path, r.gitUrl, r.branch && `branch ${r.branch}`].filter(Boolean).join(" · ")}`);
  return lines.length ? `Its repositories:\n${lines.join("\n")}` : "";
}

/** Where the coordinator's threads run, and when to pick the other place. */
function whereLine(p: Project): string {
  const canCloud = p.repos.some((r) => r.gitUrl);
  if (!canCloud) return "Threads run on this computer, each in its own worktree. (The Nyxs cloud needs a repository URL in the project's settings.)";
  const def = p.defaults.where === "cloud" ? "in the Nyxs cloud" : "on this computer";
  return `Threads run ${def} by default. A cloud thread ("where": "cloud") clones the repository in an isolated container, keeps working with this computer off and opens a draft pull request; a local one ("where": "local") works in a worktree here and can use what is only on this computer. Pick the other place only when the user asks or the task needs it.`;
}

function shared(p: Project): string {
  const instructions = p.instructions.trim();
  const memory = projectMemory(p.id).trim();
  return [
    instructions && `## Project instructions\nThe user wrote these for every session of the project. Follow them unless the user says otherwise.\n\n${instructions}`,
    `## Project memory (MEMORY.md)\n${memory || "(empty so far)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function coordinatorPrompt(p: Project, name: ToolNamer): string {
  return `# This conversation is the Nyxs project "${p.name}"
You are the project's coordinator. The user talks to you here as one continuous conversation about the project; the real work happens in threads: separate Nyxs sessions with their own context, each in its own git worktree of the project's folder, that report back here. The user sees each thread as a card in this conversation and in the project's overview (waiting on you, working, to review, resolved).
${folders(p)}

- Answer quick questions yourself: about the project, its code, or what the threads did. Reading files for that is fine.
- For each real task (a change to the code, a bug to investigate, anything longer than a couple of minutes), open a thread with ${name("start_thread")}. One thread per independent task; when one message asks for several unrelated things, open one thread for each. Give it a short title and complete instructions: it can't see this conversation.
- ${whereLine(p)}
- A follow-up in the area of an existing thread goes to that thread with ${name("message_thread")}, not to a new one. ${name("list_threads")} lists them and ${name("read_thread")} reads one.
- Never do long work yourself: don't edit the project's files and don't run long commands here.
- After starting or messaging threads, end your turn with one short line; don't wait for them. Their reports arrive here as messages: then tell the user in a sentence or two what the thread did or what it needs. When a thread or the user needs to choose between 2 to 4 clear options, ask with ${name("ask_decision")}; the choice comes back as the user's next message.
- When the user is done with a thread's work, mark it with ${name("set_thread_status")} (resolved, or idle to set it aside).
- Keep the project's memory short: when you learn something that should last (a decision, a convention, where things are), call ${name("update_memory")} with the whole new text. It is read by every session of the project; it is not a log.

${shared(p)}`;
}

export function threadPrompt(p: Project, name: ToolNamer): string {
  return `# You are a thread of the Nyxs project "${p.name}"
The project's coordinator opened this session for one task; its first message has the instructions. You work in your own git worktree of the project's folder, on your own branch, so other threads' changes don't get in the way.
${folders(p)}

- Do the whole task here. Commit your work on your branch when it is done, unless the instructions say otherwise.
- When you finish, fail or need the user, call ${name("report")} with a short summary: what you did, the branch, what is left. Status "review" when it's done, "needs_input" when you need an answer (put the question in the text), "failed" when you can't do it. "working" is only for a progress note on long work.
- Ending your turn without ${name("report")} counts as "review", with your last message as the summary.

${shared(p)}`;
}

/** The part of a project session's system prompt about its project, or "" outside a project. */
export function projectPromptFor(chatId: string | undefined | null, name: ToolNamer = builtinNamer): string {
  const role = projectRoleOf(chatId);
  const project = projectById(role?.projectId);
  if (!role || !project) return "";
  return promptFor(project, role.role, name);
}

export function promptFor(p: Project, role: ProjectRole, name: ToolNamer): string {
  return role === "coordinator" ? coordinatorPrompt(p, name) : threadPrompt(p, name);
}
