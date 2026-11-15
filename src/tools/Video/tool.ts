import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import { builtinVideoToolName, VIDEO_TOOLS, type VideoToolResult } from "@/lib/videoTools";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";

/** Lets the built-in models read and drive the video editor (see src/lib/videoTools.ts). */
export function addVideoTools(tools: ToolSet, ctx: ToolContext): void {
  const { allowImages, nativeToolImages, browserChat, sessionKey, workspace, gate, trackEdit, resolve } = ctx;
  for (const def of VIDEO_TOOLS) {
    // A model that can't see images gets no pictures; a frame can't be judged from a path.
    if (def.image && !allowImages) continue;
    const name = builtinVideoToolName(def.name);
    tools[name] = tool({
      description: def.description,
      inputSchema: jsonSchema<Record<string, unknown>>(def.inputSchema as JSONSchema7),
      execute: async (input, { abortSignal, toolCallId }): Promise<VideoToolResult> => {
        if (!def.readOnly) {
          const denied = await checkGate(gate, name, input ?? {});
          if (denied) return { text: denied };
        }
        try {
          return await def.run(input ?? {}, { chat: browserChat ?? sessionKey, workspace, signal: abortSignal, toolCallId, trackEdit, resolve });
        } catch (e) {
          return { text: `Error: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
      toModelOutput: ({ output }) => {
        // Plan mode's and a denied gate's wrappers answer with plain text.
        if (typeof output === "string") return { type: "text", value: output };
        const { text, image } = output as VideoToolResult;
        if (!image || !allowImages) return { type: "text", value: text };
        const attached = nativeToolImages
          ? { type: "image-data" as const, data: image.data, mediaType: image.mediaType }
          : { type: "file-data" as const, data: image.data, mediaType: image.mediaType, filename: "frame.jpg" };
        return { type: "content", value: [{ type: "text", text }, attached] };
      },
    });
  }
}
