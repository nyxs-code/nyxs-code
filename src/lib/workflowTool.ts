import { tool } from "ai";
import { z } from "zod";
import { makeOrchestrator, type RunnerDeps } from "./orchestratorRunner";
import { createOrchestrator, type AgentRunner } from "./orchestrator";
import { getWorkflowStore, resetWorkflow } from "./workflowSession";

export function getWorkflowToolDescription(): string {
  return `Run a deterministic MULTI-AGENT workflow (fans out several sub-agents). Progress streams live to the Workflow view.

IMPORTANT — when the user asks to "use Workflow", or for a multi-dimension code review, call THIS tool DIRECTLY in ONE step. Do NOT first explore the project manually with the Agent tool and do NOT run a separate "review" skill — that duplicates the fan-out (you'd spawn agents twice). Each workflow agent already inspects the code it needs on its own; just pass the target as \`task\`.

USE SPARINGLY otherwise — it spawns multiple agents and costs tokens; for a single investigation use the Agent tool instead.

Modes:
- "review": adversarial review of \`task\` across correctness, security and performance dimensions; each finding is independently verified and only majority-confirmed ones are returned (kills false positives). This is the canonical way to review code — prefer it over a manual explore-then-review.
- "parallel": run the SAME task across each of \`items\` concurrently (one sub-agent per item), then aggregate the reports. Great for "analyze each of these files" or "research each of these questions".`;
}

export const MAX_WORKFLOW_ITEMS = 50;

/** `chatId` is the chat whose Workflow view shows the run. */
export function buildWorkflowTool(deps: RunnerDeps, maxAgents = 12, signal?: AbortSignal, runAgent?: AgentRunner, chatId?: string) {
  return tool({
    description: getWorkflowToolDescription(),
    inputSchema: z.object({
      mode: z.enum(["parallel", "review"]).describe("parallel = fan-out over items; review = adversarial review of a target."),
      task: z.string().describe("What to do — the instruction each agent receives, or the target to review."),
      items: z
        .array(z.string())
        .optional()
        .describe("For mode 'parallel': the items to fan out over (one sub-agent per item)."),
    }),
    execute: async ({ mode, task, items }) => {
      resetWorkflow(chatId);
      const concurrency = Math.max(1, Math.min(maxAgents, 8));
      const orchOpts = { concurrency, signal, onEvent: getWorkflowStore(chatId).dispatch };
      const o = runAgent ? createOrchestrator(runAgent, orchOpts) : makeOrchestrator(deps, orchOpts);
      try {
        if (mode === "parallel") {
          const all = (items ?? []).map((s) => s.trim()).filter(Boolean);
          const list = all.slice(0, MAX_WORKFLOW_ITEMS);
          const skipped = all.slice(MAX_WORKFLOW_ITEMS);
          if (!list.length) {
            return "mode 'parallel' needs a non-empty `items` array (one sub-agent runs per item).";
          }
          o.phase("Parallel");
          const results = await o.parallel(
            list.map((it) => () => o.agent(`${task}\n\nFocus on this item:\n${it}`, { label: it.slice(0, 48) })),
          );
          const okN = results.filter(Boolean).length;
          const body = results.map((r, i) => `## ${list[i]}\n${r ?? "(this agent failed)"}`).join("\n\n");
          const skippedNote = skipped.length
            ? `\n\n${skipped.length} item(s) were NOT run (at most ${MAX_WORKFLOW_ITEMS} per workflow): ${skipped.join("; ")}`
            : "";
          return `Workflow 'parallel' done — ${okN}/${all.length} agents succeeded.\n\n${body}${skippedNote}`;
        }

        const instr =
          "Be THOROUGH. First map the relevant files with Glob/ListDir, then read EVERY important source file — each file AT MOST ONCE (never re-read the same file). " +
          "Report EVERY concrete issue you find (don't stop at the first few), as a bullet list. For each: `path:line`, a severity (low/medium/high), why it's a problem, and a concrete fix. " +
          "Cover edge cases and less-obvious problems, not just the headline ones. If after a genuine review there are truly no issues in this dimension, say so in one line.";
        const dimensions = [
          { key: "correctness", prompt: `Review the target for CORRECTNESS bugs: logic errors, wrong/edge-case handling, off-by-one, null/undefined, race conditions, incorrect types, broken control flow, wrong assumptions.\n\nTarget: ${task}\n\n${instr}` },
          { key: "security", prompt: `Review the target for SECURITY issues: injection (SQL/XSS/command), unsafe input handling, missing validation, leaked/hardcoded secrets, path traversal, auth/session gaps, insecure defaults, unsafe deserialization, CORS/CSRF.\n\nTarget: ${task}\n\n${instr}` },
          { key: "performance", prompt: `Review the target for PERFORMANCE problems: needless work, N+1 queries, blocking I/O on hot paths, bad algorithmic complexity, unnecessary re-renders/allocations, missing caching/memoization, large bundles.\n\nTarget: ${task}\n\n${instr}` },
          { key: "quality", prompt: `Review the target for CODE QUALITY & maintainability: dead/duplicated code, poor naming, overly long functions, missing/weak types, tight coupling, unclear structure, missing error handling, inconsistent style, magic values.\n\nTarget: ${task}\n\n${instr}` },
          { key: "best-practices", prompt: `Review the target for BEST PRACTICES of its stack/framework: idiomatic usage, accessibility (a11y) for UI/HTML, proper error/loading states, configuration & env handling, testing gaps, and deviations from the framework's recommended patterns.\n\nTarget: ${task}\n\n${instr}` },
        ];
        o.phase("Review");
        const reviews = await o.parallel(
          dimensions.map((d) => () => o.agent(d.prompt, { label: `review:${d.key}`, phase: "Review" })),
        );
        const okN = reviews.filter(Boolean).length;
        const body = dimensions
          .map((d, i) => `## ${d.key}\n${reviews[i]?.trim() || "(this review produced no output)"}`)
          .join("\n\n");
        return `Workflow 'review' done — ${okN}/${dimensions.length} dimensions reviewed.\n\n${body}`;
      } catch (e) {
        return `Workflow failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}
