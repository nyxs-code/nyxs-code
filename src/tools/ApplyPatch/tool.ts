import { invoke } from "@/lib/ipc";
import { tool } from "ai";
import { z } from "zod";
import { isProtectedConfigPath } from "@/lib/permissions";
import { getApplyPatchDescription } from "@/tools/ApplyPatch/prompt";
import { parsePatch, PatchError, type PatchHunk, type PatchOp } from "@/tools/ApplyPatch/parse";
import { truncatedToolCalls } from "@/tools/Write/truncated";
import type { ToolContext } from "@/tools/context";
import { withFileLock } from "@/tools/fileLock";
import { checkGate } from "@/tools/gate";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";

/**
 * Whether a model edits files with `apply_patch` rather than Edit/Write/MultiEdit. opencode's
 * rule (its tool registry, 1.x): GPT models write Codex's patch format better than exact string
 * replacements, except the open-weight gpt-oss and the GPT-4 family. Decided by the model alone,
 * so its tool catalog (and the prompt cache) stays the same from turn to turn.
 */
export function usesApplyPatch(apiModel: string): boolean {
  const id = apiModel.toLowerCase();
  return id.includes("gpt-") && !id.includes("oss") && !id.includes("gpt-4");
}

/** An edit as `agent_multi_edit` takes it. */
interface EditOp {
  oldString: string;
  newString: string;
}

/** A hunk as an exact replacement, for the same matching (exact, then fuzzy) Edit gets. A hunk
 *  with only added lines goes after its "@@" line, or at the end of the file. */
function hunkEdit(h: PatchHunk, n: number, path: string, fileLines: () => string[]): EditOp {
  const added = h.newLines.join("\n");
  if (h.oldLines.length) return { oldString: h.oldLines.join("\n"), newString: added };
  const lines = fileLines();
  if (h.header) {
    const wanted = h.header.trim();
    const found = lines.filter((l) => l.trim() === wanted);
    if (found.length !== 1) {
      throw new PatchError(
        `Hunk ${n} in ${path} has no context lines, and its "@@ ${wanted}" line is ${found.length ? `in the file ${found.length} times` : "not in the file"}. Add a few unchanged lines around the change (prefixed with a space).`,
      );
    }
    return { oldString: found[0], newString: `${found[0]}\n${added}` };
  }
  // Appended at the end: anchored on the file's last lines.
  const tail = lines.slice(0, lines.length - (lines[lines.length - 1] === "" ? 1 : 0)).slice(-3);
  if (!tail.length) throw new PatchError(`Hunk ${n} in ${path} has no context lines and the file is empty. Add the lines with "*** Add File:" instead.`);
  return { oldString: tail.join("\n"), newString: `${tail.join("\n")}\n${added}` };
}

/** Edit's error text, told in terms of the patch. */
function hunkError(message: string, path: string): string {
  return message
    .replace(/^Edit #(\d+): /, `Hunk $1 in ${path}: `)
    .replace(/old_string/g, "the hunk's context and removed lines")
    .replace(/, or use replace_all/, "")
    .replace(/ No change was applied\.$/, ` Nothing in ${path} was changed.`);
}

export function createApplyPatchTool(ctx: ToolContext) {
  const { gate, scope, resolve, pathInput, trackEdit, guardStaleEdit, recordWrite, withDiagnostics } = ctx;
  const allowConfig = (abs: string) => Boolean(gate) && isProtectedConfigPath(abs);

  /** Writes a whole file the way Write does (permission, read-first check, history). */
  const writeFile = async (path: string, content: string): Promise<string> => {
    const abs = resolve(path);
    const denied = await checkGate(gate, "Write", pathInput(path, abs));
    if (denied) throw new PatchError(denied);
    return withFileLock(abs, async () => {
      const stale = await guardStaleEdit(abs, APPLY_PATCH_TOOL_NAME);
      if ("blocked" in stale) throw new PatchError(stale.blocked);
      await trackEdit(abs);
      const out = await invoke<string>("agent_write_file", { path: abs, content, scope, allowConfig: allowConfig(abs), expectedMtime: stale.expectedMtime });
      await recordWrite(abs, content.length);
      return withDiagnostics(out, abs);
    });
  };

  const apply = async (op: PatchOp): Promise<{ mark: string; out: string }> => {
    if (op.type === "add") return { mark: `A ${op.path}`, out: await writeFile(op.path, op.content) };
    const abs = resolve(op.path);
    if (op.type === "delete") {
      const denied = await checkGate(gate, "Edit", pathInput(op.path, abs));
      if (denied) throw new PatchError(denied);
      return withFileLock(abs, async () => {
        // Deleting needs no read first; one read earlier must still be the current version.
        const seen = ctx.fileState.get(abs)?.mtime;
        await trackEdit(abs);
        const out = await invoke<string>("agent_delete_file", { path: abs, scope, allowConfig: allowConfig(abs), expectedMtime: seen });
        return { mark: `D ${op.path}`, out };
      });
    }
    const denied = await checkGate(gate, "Edit", pathInput(op.path, abs));
    if (denied) throw new PatchError(denied);
    const out = await withFileLock(abs, async () => {
      const stale = await guardStaleEdit(abs, APPLY_PATCH_TOOL_NAME);
      if ("blocked" in stale) throw new PatchError(stale.blocked);
      let text: string | null | undefined;
      const fileLines = () => (text ?? "").replace(/\r\n/g, "\n").split("\n");
      if (op.hunks.some((h) => !h.oldLines.length)) text = await invoke<string | null>("agent_read_text", { path: abs, scope });
      const edits = op.hunks.map((h, i) => hunkEdit(h, i + 1, op.path, fileLines));
      let edited = "";
      if (edits.length) {
        await trackEdit(abs);
        try {
          edited = await invoke<string>("agent_multi_edit", { path: abs, edits, scope, allowConfig: allowConfig(abs), expectedMtime: stale.expectedMtime });
        } catch (err) {
          throw new PatchError(hunkError(err instanceof Error ? err.message : String(err), op.path));
        }
        await recordWrite(abs, 0);
      }
      return op.moveTo ? edited : withDiagnostics(edited, abs);
    });
    if (!op.moveTo) return { mark: `M ${op.path}`, out };
    // Moved: the new file gets the result, then the old one goes.
    const content = (await invoke<string | null>("agent_read_text", { path: abs, scope })) ?? "";
    const written = await writeFile(op.moveTo, content);
    await trackEdit(abs);
    await invoke<string>("agent_delete_file", { path: abs, scope, allowConfig: allowConfig(abs) });
    return { mark: `R ${op.path} → ${op.moveTo}`, out: written };
  };

  return tool({
    description: getApplyPatchDescription(),
    inputSchema: z.object({
      input: z.string().describe('The whole patch, from "*** Begin Patch" to "*** End Patch".'),
    }),
    execute: async ({ input }, { toolCallId }) => {
      if (truncatedToolCalls.delete(toolCallId)) {
        return "ERROR: the output was cut off before the patch was complete, so nothing was applied. Send a smaller patch (fewer files or hunks per call).";
      }
      let ops: PatchOp[];
      try {
        ops = parsePatch(input);
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)} Nothing was applied.`;
      }
      // One file at a time, in order: each is all-or-nothing, as Edit is.
      const done: { mark: string; out: string }[] = [];
      for (const op of ops) {
        try {
          done.push(await apply(op));
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          const left = ops.slice(done.length + 1).map((o) => o.path);
          return [
            `ERROR applying the patch to ${op.path}: ${why}`,
            done.length ? `Already applied (left as they are now): ${done.map((d) => d.mark).join(", ")}.` : "No file was changed.",
            left.length ? `Not attempted: ${left.join(", ")}.` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }
      }
      return [`Success. Applied the patch:`, ...done.map((d) => `${d.mark}\n${d.out.trim()}`)].join("\n");
    },
  });
}
