import { invoke } from "@/lib/ipc";
import { noteShellOwner } from "@/lib/shellOwners";
import { tool } from "ai";
import { z } from "zod";
import { type RunResult, rememberCommandLogs, type BgShell, type BgOutputResult, formatRunResult } from "@/tools/Bash/format";
import { getBashDescription } from "@/tools/Bash/prompt";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";
import { TOOL_OUTPUT_LIMITS, outputLimitFor, truncateMiddle } from "@/tools/limits";
import * as Names from "@/tools/toolNames";

export function createBashTool(ctx: ToolContext) {
  const { workspace, gate, promptEnv, resolve, bgOffsets, env, browserChat } = ctx;
  return tool({
    description: getBashDescription(promptEnv),
    inputSchema: z.object({
      description: z
        .string()
        .optional()
        .describe("A short 3-6 word title for this command (e.g. \"Run test suite\", \"Start dev server\"). Shown as the task title in the Background tasks view — prefer it over showing the raw command."),
      command: z.string().describe("The command to execute."),
      timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("Timeout in ms (default 120000). Ignored when run_in_background is true."),
      run_in_background: z
        .boolean()
        .optional()
        .describe("Run the command in the background and return a shell ID immediately (for long-running commands)."),
      cwd: z
        .string()
        .optional()
        .describe("Directory to run the command in (absolute or relative to the workspace). Defaults to the workspace root. Prefer this over chaining `cd` for monorepo subpackages."),
    }),
    execute: async ({ command, description, timeout_ms, run_in_background, cwd }, { abortSignal }) => {
      const denied = await checkGate(gate, "Bash", { command });
      if (denied) return denied;
      if (abortSignal?.aborted) return "Command not run: the turn was cancelled.";
      const runCwd = cwd ? resolve(cwd) : workspace;
      if (run_in_background) {
        const sh = await invoke<BgShell>("agent_run_background", { command, cwd: runCwd, description, env: env ?? null });
        bgOffsets.set(sh.id, 0);
        noteShellOwner(sh.id, browserChat);
        return (
          `Command started in the background.\n` +
          `Shell ID: ${sh.id}\n` +
          `Its output streams live in the Terminal view. Use BashOutput with this ID to read new output, ` +
          `or KillShell to stop it. You'll need the ID to check on it later.`
        );
      }
      const runId = crypto.randomUUID();
      const cancel = () => void invoke("agent_run_cancel", { runId });
      abortSignal?.addEventListener("abort", cancel, { once: true });
      let res: RunResult;
      try {
        res = await invoke<RunResult>("agent_run", {
          command,
          cwd: runCwd,
          timeoutMs: timeout_ms,
          runId,
          // A saved environment's variables; without them the command runs in the shared shell.
          env: env ?? null,
          logOverBytes: Math.floor(outputLimitFor(Names.BASH_TOOL_NAME) / 3),
        });
      } finally {
        abortSignal?.removeEventListener("abort", cancel);
      }
      rememberCommandLogs(res);
      return formatRunResult(res, outputLimitFor(Names.BASH_TOOL_NAME));
    },
  });
}

export function createBashOutputTool(ctx: ToolContext) {
  const { bgOffsets } = ctx;
  return tool({
    description: `Retrieves output from a background shell started with Bash (run_in_background).

Usage:
- Returns only the NEW output since your last BashOutput call for that shell, so you can call it repeatedly to follow progress.
- Reports the shell's status ("running", "done", or "killed") and the exit code once it finishes.
- This call BLOCKS (waits) until there is new output, the shell finishes, or \`wait_ms\` elapses — so a single call genuinely waits instead of returning immediately. Do NOT poll in a tight loop: to wait for a command to finish, call this ONCE with the default (or a larger \`wait_ms\`) and, if it's still "running" with no useful output, call it again — each call already waits for you.
- If you only want a non-blocking snapshot of current output, pass \`wait_ms: 0\`.`,
    inputSchema: z.object({
      shell_id: z.string().describe("The background shell ID returned by Bash run_in_background."),
      filter: z.string().optional().describe("Optional regex; only output lines matching it are returned."),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe("How long to wait (ms) for new output or completion before returning. Default 30000. Pass 0 for an immediate, non-blocking snapshot."),
    }),
    execute: async ({ shell_id, filter, wait_ms }) => {
      const after = bgOffsets.get(shell_id) ?? 0;
      const waitMs = wait_ms ?? 30_000;
      const res = await invoke<BgOutputResult>("agent_bg_output", { id: shell_id, after, waitMs });
      bgOffsets.set(shell_id, res.nextOffset);
      let out = res.output;
      if (filter) {
        try {
          const re = new RegExp(filter);
          out = out.split("\n").filter((l) => re.test(l)).join("\n");
        } catch {
          // Invalid regex: fall back to the unfiltered output.
        }
      }
      const status = `[status: ${res.status}${res.code != null ? `, exit code: ${res.code}` : ""}]`;
      const body = out.trim() ? truncateMiddle(out.trimEnd(), TOOL_OUTPUT_LIMITS.default - status.length, 1 / 5) : "(no new output)";
      return `${status}\n${body}`;
    },
  });
}

export function createKillShellTool(ctx: ToolContext) {
  const { gate } = ctx;
  return tool({
    description: `Stops a running background shell by its ID (e.g. a dev server or watcher started with Bash run_in_background). No-op if it already finished.`,
    inputSchema: z.object({
      shell_id: z.string().describe("The background shell ID to stop."),
    }),
    execute: async ({ shell_id }) => {
      const denied = await checkGate(gate, "KillShell", { shell_id });
      if (denied) return denied;
      return await invoke<string>("agent_bg_kill", { id: shell_id });
    },
  });
}
