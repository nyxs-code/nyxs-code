import { tool } from "ai";
import { z } from "zod";
import { getGitStatusDescription, getGitDiffDescription, getGitLogDescription, getGitBlameDescription } from "@/tools/Git/prompt";
import { runGit } from "@/tools/Git/run";
import type { ToolContext } from "@/tools/context";

/** A repo-relative path from the model, where it is on disk; as is when it doesn't resolve
 *  there (a pathspec that git itself will judge). */
function onDisk(ctx: ToolContext, path: string): string {
  try {
    return ctx.resolveRead(path);
  } catch {
    return path;
  }
}

/** Asks Read's gate for the file or folder a Git tool was given. */
const gatePath = (ctx: ToolContext, path: string) => ctx.gateRead(path, onDisk(ctx, path), true);

/** A diff without the sections of files a deny rule hides from the model. */
export function withoutDeniedDiffs(diff: string, denied: (path: string) => boolean): string {
  const sections = diff.split(/^(?=diff --git )/m);
  const kept = sections.filter((s) => {
    const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/m.exec(s);
    return !m || (!denied(m[1]) && !denied(m[2]));
  });
  return kept.length === sections.length ? diff : kept.join("") || "(no output)";
}

export function createGitStatusTool(ctx: ToolContext) {
  const { workspace } = ctx;
  return tool({
    description: getGitStatusDescription(),
    inputSchema: z.object({}),
    execute: async () => runGit(["status", "--short", "--branch"], workspace),
  });
}

export function createGitDiffTool(ctx: ToolContext) {
  const { workspace } = ctx;
  return tool({
    description: getGitDiffDescription(),
    inputSchema: z.object({
      staged: z.boolean().optional().describe("Show staged changes (git diff --staged) instead of unstaged working-tree changes."),
      path: z.string().optional().describe("Limit the diff to this file or directory (relative to the repo)."),
      commit: z.string().optional().describe('A commit or range to diff against (e.g. "HEAD~3", "main..HEAD").'),
      stat: z.boolean().optional().describe("Show only a summary (files changed + insertions/deletions)."),
    }),
    execute: async ({ staged, path, commit, stat }) => {
      const rev = commit?.trim();
      if (rev?.startsWith("-")) return "Error: `commit` must be a revision or range (e.g. HEAD~3), not a command-line option.";
      const a = ["diff"];
      if (staged) a.push("--staged");
      if (stat) a.push("--stat");
      if (rev) a.push(rev);
      if (path) {
        const denied = await gatePath(ctx, path);
        if (denied) return denied;
        a.push("--", path);
      }
      const out = await runGit(a, workspace);
      return stat ? out : withoutDeniedDiffs(out, (p) => ctx.readDenied(onDisk(ctx, p)));
    },
  });
}

export function createGitLogTool(ctx: ToolContext) {
  const { workspace } = ctx;
  return tool({
    description: getGitLogDescription(),
    inputSchema: z.object({
      count: z.number().int().min(1).max(200).optional().describe("How many commits to show (default 20)."),
      path: z.string().optional().describe("Only show commits that touched this file or directory."),
      author: z.string().optional().describe("Filter commits by author."),
    }),
    execute: async ({ count, path, author }) => {
      const a = ["log", "-n", String(count ?? 20), "--pretty=format:%h %an %ad %s", "--date=short"];
      if (author) a.push(`--author=${author}`);
      if (path) {
        const denied = await gatePath(ctx, path);
        if (denied) return denied;
        a.push("--", path);
      }
      return runGit(a, workspace);
    },
  });
}

export function createGitBlameTool(ctx: ToolContext) {
  const { workspace } = ctx;
  return tool({
    description: getGitBlameDescription(),
    inputSchema: z.object({
      file_path: z.string().describe("File to blame (relative to the repo)."),
      start_line: z.number().int().min(1).optional().describe("First line of the range to blame."),
      end_line: z.number().int().min(1).optional().describe("Last line of the range to blame."),
    }),
    execute: async ({ file_path, start_line, end_line }) => {
      const denied = await gatePath(ctx, file_path);
      if (denied) return denied;
      const a = ["blame"];
      if (start_line) a.push("-L", `${start_line},${end_line ?? start_line}`);
      a.push("--", file_path);
      return runGit(a, workspace);
    },
  });
}
