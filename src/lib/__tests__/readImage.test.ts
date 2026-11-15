import { describe, it, expect } from "vitest";
import { generateText, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { buildTools, readImageModelOutput, type ReadImageOutput } from "@/lib/agentTools";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const png: ReadImageOutput = {
  __readImage: true,
  base64: "iVBORw0KGgo=",
  mediaType: "image/png",
  size: 2048,
  filePath: "assets\\logo.png",
};

type ToModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => unknown;

function readToModelOutput(nativeToolImages: boolean): ToModelOutput {
  const tools = buildTools({ workspace: "C:/ws", allowImages: true, nativeToolImages });
  return (tools.Read as unknown as { toModelOutput: ToModelOutput }).toModelOutput;
}

describe("Read image output", () => {
  it("sends images as image-data parts to providers that take images in tool results", () => {
    expect(readImageModelOutput(png, true)).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Read image assets\\logo.png (2 KB). The image is attached below." },
        { type: "image-data", data: "iVBORw0KGgo=", mediaType: "image/png" },
      ],
    });
  });

  it("keeps the previous file-data shape for openai-compatible providers", () => {
    const out = readImageModelOutput(png, false);
    expect(out.value[1]).toEqual({ type: "file-data", data: "iVBORw0KGgo=", mediaType: "image/png", filename: "logo.png" });
  });

  it("is wired into the Read tool", () => {
    const native = readToModelOutput(true)({ toolCallId: "1", input: { file_path: png.filePath }, output: png });
    expect(native).toMatchObject({ type: "content", value: [{ type: "text" }, { type: "image-data", mediaType: "image/png" }] });

    const compat = readToModelOutput(false)({ toolCallId: "2", input: { file_path: png.filePath }, output: png });
    expect(compat).toMatchObject({ type: "content", value: [{ type: "text" }, { type: "file-data", filename: "logo.png" }] });

    expect(readToModelOutput(true)({ toolCallId: "3", input: {}, output: "plain text" })).toEqual({ type: "text", value: "plain text" });
  });
});

async function anthropicToolResultBlocks(nativeToolImages: boolean): Promise<Array<Record<string, unknown>>> {
  let body: { messages: Array<{ role: string; content: Array<{ type: string; content?: Array<Record<string, unknown>> }> }> } | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const model = createAnthropic({ apiKey: "test", fetch: fetchImpl })("claude-test");
  const messages: ModelMessage[] = [
    { role: "user", content: "Look at the logo" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "Read", input: { file_path: png.filePath } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "Read", output: readImageModelOutput(png, nativeToolImages) }] },
  ];
  await generateText({ model, messages });
  const toolResult = body?.messages.flatMap((m) => m.content).find((c) => c.type === "tool_result");
  return toolResult?.content ?? [];
}

describe("Read images on the Anthropic provider", () => {
  it("reach the API as an image block", async () => {
    const blocks = await anthropicToolResultBlocks(true);
    expect(blocks).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
  });

  it("were dropped with the old file-data shape", async () => {
    const blocks = await anthropicToolResultBlocks(false);
    expect(blocks.some((b) => b.type === "image")).toBe(false);
  });
});
