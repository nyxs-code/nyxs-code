import type { ActivityEvent } from "@/lib/agentActivity";
import { getAgentDescription } from "@/tools/Agent/prompt";

export interface SubagentDef {
  type: string;
  whenToUse: string;
  readOnly: boolean;
  toolsLabel: string;
  systemPrompt?: string;
  tools?: string[];
  model?: string;
  source?: "builtin" | "project" | "user";
}

export const SUBAGENT_TYPES: SubagentDef[] = [
  {
    type: "general-purpose",
    whenToUse:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
    readOnly: false,
    toolsLabel: "Read, Write, Edit, MultiEdit, Glob, Grep, Bash, ListDir",
  },
  {
    type: "Explore",
    whenToUse:
      'Fast, read-only agent specialized for exploring codebases. Use it to quickly find files by pattern ("src/**/*.tsx"), search code for keywords ("API endpoints"), or answer questions about the codebase ("how do API endpoints work?"). Specify the desired thoroughness: "quick", "medium" or "very thorough".',
    readOnly: true,
    toolsLabel: "Read, Glob, Grep, ListDir, WebFetch, WebSearch",
  },
  {
    type: "verify",
    whenToUse:
      "Checks that the project still builds and its tests pass after a change. It finds the right install/lint/typecheck/test commands (and saves them to .nyxs/environment.json for next time), runs them, and reports what failed with the relevant output. It does not fix code. Use it after a non-trivial change, before telling the user the work is done.",
    readOnly: false,
    toolsLabel: "Read, Glob, Grep, ListDir, Bash, BashOutput, KillShell, Write",
    tools: ["Read", "Glob", "Grep", "ListDir", "Bash", "BashOutput", "KillShell", "Write"],
    source: "builtin",
    systemPrompt: `You verify a change. You never edit source code.

1. Read .nyxs/environment.json if it exists. It holds the commands that worked before: {"install"?, "lint"?, "typecheck"?, "test"?, "build"?, "notes"?}.
2. If it is missing or a command no longer exists, work the commands out from the project files (package.json scripts and lockfile, Cargo.toml, pyproject.toml, go.mod, Makefile, CI workflows under .github/workflows). Prefer the project's own scripts. Then write .nyxs/environment.json with what you found. That file is the only one you may write.
3. Run, in this order and only what exists: typecheck, lint, test (the narrowest test command that covers the change if the task names files), build only when asked or when there are no tests. Skip install unless a command fails because dependencies are missing.
4. When a command fails, retry at most once and only for a known transient cause (a missing install, a port in use, a flaky network fetch). Do not try other variations to make it pass.

Report: for each command, the exact command, pass or fail, and for failures the first relevant error lines (file:line and message). End with one line: VERIFIED, FAILED or COULD NOT VERIFY (and why).`,
  },
];

export const DEFAULT_SUBAGENT_TYPE = "general-purpose";

export function resolveSubagentType(
  type: string | undefined,
  extra: SubagentDef[] = [],
): SubagentDef {
  const all = extra.length ? [...SUBAGENT_TYPES, ...extra] : SUBAGENT_TYPES;
  return all.find((a) => a.type === type) ?? SUBAGENT_TYPES[0];
}

export function buildAgentToolDescription(models: string[] = [], extra: SubagentDef[] = []): string {
  const listing = [...SUBAGENT_TYPES, ...extra]
    .map((a) => `- ${a.type}: ${a.whenToUse} (Tools: ${a.toolsLabel})`)
    .join("\n");
  return getAgentDescription(listing, models);
}

export type SubagentRunner = (task: {
  description: string;
  prompt: string;
  subagentType: string;
  model?: string;
  fork?: boolean;
  signal?: AbortSignal;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** Its text and tool calls as they happen, for the background tasks view. */
  onActivity?: (activity: ActivityEvent) => void;
  reflect?: boolean;
}) => Promise<string>;
