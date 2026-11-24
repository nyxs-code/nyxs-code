import { tool } from "ai";
import { z } from "zod";
import { invoke } from "@/lib/ipc";
import { noteShellOwner } from "@/lib/shellOwners";
import { memoryLimitLifted } from "@/lib/commandMemory";
import type { BgShell } from "@/tools/Bash/format";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";

export const MONITOR_TOOL_NAME = "Monitor";

/** What the agent is told once a monitor runs; `trackBackgroundShells` finds the shell by it. */
export function monitorStarted(id: string): string {
  return (
    `Monitor started.\nShell ID: ${id}\n` +
    `Each time the command prints new lines you'll get them in a <monitor-event> in this chat, a few seconds' worth at ` +
    `a time, even after this turn ends; don't poll it with BashOutput. When it ends you'll get a <task-notification>. ` +
    `Stop it with KillShell when you no longer need it.`
  );
}

/**
 * Claude Code's Monitor, for Nyxs's own agent: a command left running in the background whose
 * new output lines wake the agent (BackgroundWaker), so it can react to a log, a test watcher
 * or a deploy instead of polling. It runs as a background shell: the Background tasks view
 * shows it and KillShell stops it.
 */
export function createMonitorTool(ctx: ToolContext) {
  const { workspace, gate, resolve, bgOffsets, env, browserChat } = ctx;
  return tool({
    description: `Starts a background monitor: runs a command that keeps printing (a log followed with tail -f, a test watcher, a deploy's status) and wakes you with the new lines it prints, as a <monitor-event> in this chat, even after this turn ends. Use it to react to events as they happen instead of polling with BashOutput.

Usage:
- Filter the command so it only prints what matters (e.g. \`tail -f app.log | grep --line-buffered ERROR\`): every batch of lines wakes you.
- Lines are grouped: you get what it printed over a few seconds at once, never in the middle of a reply.
- It runs until it ends by itself or you stop it with KillShell and its Shell ID. Stop it once you no longer need it.
- For a command you only want to wait for, use Bash with run_in_background instead: you're told when it ends.`,
    inputSchema: z.object({
      command: z.string().describe("The command to run and watch. It should keep printing lines as things happen."),
      description: z.string().optional().describe('A short title for it, e.g. "Server errors". Shown in Background tasks.'),
      cwd: z.string().optional().describe("Directory to run it in (absolute or relative to the workspace). Defaults to the workspace root."),
    }),
    execute: async ({ command, description, cwd }, { abortSignal }) => {
      // The same permission as running the command with Bash.
      const denied = await checkGate(gate, "Bash", { command });
      if (denied) return denied;
      if (abortSignal?.aborted) return "Monitor not started: the turn was cancelled.";
      const sh = await invoke<BgShell>("agent_run_background", {
        command,
        cwd: cwd ? resolve(cwd) : workspace,
        description: description ?? null,
        env: env ?? null,
        memoryGuard: !memoryLimitLifted(browserChat),
      });
      bgOffsets.set(sh.id, 0);
      noteShellOwner(sh.id, browserChat);
      return monitorStarted(sh.id);
    },
  });
}
