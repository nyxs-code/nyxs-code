import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import { BROWSER_TOOLS, builtinBrowserToolName, type BrowserStepGate, type BrowserToolResult } from "@/lib/browserTools";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";

/** Lets the built-in models look at and drive the app in the built-in browser. */
export function addBrowserTools(tools: ToolSet, ctx: ToolContext): void {
  const { allowImages, nativeToolImages, browserChat, gate } = ctx;
  const stepGate: BrowserStepGate = (step, input) => checkGate(gate, builtinBrowserToolName(step.name), input);
  for (const def of BROWSER_TOOLS) {
    // A model that can't see images gets no screenshots; snapshot covers the rest.
    if (def.name === "screenshot" && !allowImages) continue;
    const name = builtinBrowserToolName(def.name);
    tools[name] = tool({
      description: def.description,
      inputSchema: jsonSchema<Record<string, unknown>>(def.inputSchema as JSONSchema7),
      execute: async (input): Promise<BrowserToolResult> => {
        // A batch asks for each of its steps under that step's own name instead, so a batch of
        // reads stays free and an action in it asks just as it would on its own.
        if (def.name !== "batch") {
          const denied = await checkGate(gate, name, input ?? {});
          if (denied) return { text: denied };
        }
        try {
          return await def.run(input ?? {}, browserChat, stepGate);
        } catch (e) {
          return { text: `Error: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
      toModelOutput: ({ output }) => {
        const { text, image } = output as BrowserToolResult;
        if (!image) return { type: "text", value: text };
        const attached = nativeToolImages
          ? { type: "image-data" as const, data: image.data, mediaType: image.mediaType }
          : { type: "file-data" as const, data: image.data, mediaType: image.mediaType, filename: "screenshot.jpg" };
        return { type: "content", value: [{ type: "text", text }, attached] };
      },
    });
  }
}
