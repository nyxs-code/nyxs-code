import { invoke } from "@/lib/ipc";
import { tool } from "ai";
import { z } from "zod";
import { readFingerprint } from "@/lib/fileStateCache";
import { IMAGE_EXT_RE, type FileRange, formatReadRange, type ReadImageOutput, readImageModelOutput } from "@/tools/Read/format";
import { nestedInstructionsFor } from "@/tools/Read/nested";
import { getReadDescription } from "@/tools/Read/prompt";
import { VIDEO_EXT_RE } from "@/tools/WatchVideo/format";
import type { ToolContext } from "@/tools/context";
import { outputLimitFor } from "@/tools/limits";
import * as Names from "@/tools/toolNames";

export function createReadTool(ctx: ToolContext) {
  const { allowImages, nativeToolImages, scope, resolveRead, gateRead, fileState, visibleReads, workspace, session } = ctx;
  return tool({
    description: getReadDescription(),
    inputSchema: z.object({
      file_path: z.string().describe("Path of the file to read (absolute or relative to the workspace)."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Line number to start reading from (1-based, the same numbers shown in the output). Only needed for long files."),
      limit: z.number().int().min(1).optional().describe("Maximum number of lines to read."),
    }),
    execute: async ({ file_path, offset, limit }) => {
      const abs = resolveRead(file_path);
      const denied = await gateRead(file_path, abs);
      if (denied) return denied;
      if (VIDEO_EXT_RE.test(abs)) {
        return `[${file_path} is a video. Use ${Names.WATCH_VIDEO_TOOL_NAME} to watch it.]`;
      }
      if (IMAGE_EXT_RE.test(abs)) {
        if (!allowImages) {
          return `[${file_path} is an image. The current model can't view images — switch to a vision-capable model, or ask the user to describe it.]`;
        }
        try {
          const img = await invoke<{ base64: string; mediaType: string; size: number }>("agent_read_image", { path: abs, scope });
          const output: ReadImageOutput = { __readImage: true, base64: img.base64, mediaType: img.mediaType, size: img.size, filePath: file_path };
          return output;
        } catch (e) {
          return `Failed to read image ${file_path}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const start = Math.max(1, offset ?? 1);
      let mtime: number | null = null;
      try {
        mtime = await invoke<number | null>("agent_file_mtime", { path: abs });
      } catch {
        // mtime is a best-effort hint; ignore failures.
      }
      const prev = mtime != null ? fileState.get(abs) : undefined;
      const last = prev?.read;
      if (
        last &&
        last.mtime === mtime &&
        last.offset === start &&
        last.limit === (limit ?? null) &&
        visibleReads.has(last.fingerprint)
      ) {
        return `[${file_path} is unchanged since your earlier Read of the same lines, and that result is still in your context, so it is not repeated. Use it, or read a different range.]`;
      }
      const range = await invoke<FileRange>("agent_read_file_range", {
        path: abs,
        offset: start - 1,
        limit,
        scope,
      });
      const notes: string[] = [];
      if (last && prev && last.mtime !== mtime && prev.mtime !== mtime) {
        notes.push("[Note: this file changed on disk since you last read it — the contents below are current.]");
      }
      if (range.encoding) {
        notes.push(`[Decoded as ${range.encoding}. Edit and Write refuse to modify it until it is converted to UTF-8.]`);
      }
      if ((range.longLines ?? 0) > 0) {
        notes.push(`[${range.longLines} line(s) longer than 2000 characters were clipped.]`);
      }
      const prefix = notes.length ? `${notes.join("\n")}\n\n` : "";
      let result = prefix + formatReadRange(range, outputLimitFor(Names.READ_TOOL_NAME) - prefix.length);
      if (session.nestedInstructions && workspace) {
        const nested = await nestedInstructionsFor(abs, workspace, session.nestedInstructions, scope).catch(() => "");
        if (nested) result = `${result}\n\n${nested}`;
      }
      if (mtime != null) {
        const fingerprint = readFingerprint(result);
        fileState.set(abs, {
          mtime,
          size: range.text.length,
          read: { mtime, offset: start, limit: limit ?? null, fingerprint },
        });
        visibleReads.add(fingerprint);
      }
      return result;
    },
    toModelOutput: ({ output }) => {
      if (output && typeof output === "object" && "__readImage" in output) {
        return readImageModelOutput(output as ReadImageOutput, nativeToolImages);
      }
      return { type: "text", value: String(output) };
    },
  });
}
