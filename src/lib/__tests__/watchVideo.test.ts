import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateText, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const { withToolMedia, videoMarker, nativeVideoRejected, mediaLimits } = await import("@/lib/toolMedia");
const { frameTimes, formatTimestamp } = await import("@/tools/WatchVideo/frames");
const { watchVideoModelOutput } = await import("@/tools/WatchVideo/tool");
const { compactRegistry, setRegistryIndex, registryVideo } = await import("@/lib/modelRegistry");
const { supportsVideo } = await import("@/lib/models");
const { withDocuments } = await import("@/lib/fileAttachments");
const { estimateMessageTokens } = await import("@/lib/microcompact");

type Body = Record<string, unknown>;

const chatReply = () =>
  new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const geminiReply = () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const load = vi.fn(async (path: string) => ({ base64: `B64(${path})`, mediaType: "video/mp4" }));

/** A conversation whose last tool call returned `output`, then (optionally) the user spoke again. */
function conversation(output: unknown, userAfter?: string): ModelMessage[] {
  const msgs: ModelMessage[] = [
    { role: "user", content: "Watch it" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "WatchVideo", input: { file_path: "a.mp4" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "WatchVideo", output: output as never }] },
  ];
  if (userAfter) msgs.push({ role: "user", content: userAfter });
  return msgs;
}

async function sendOpenAI(messages: ModelMessage[], responses: (() => Response)[] = [chatReply], modelKey = "qwen/qwen3.8-flash-next") {
  const bodies: Body[] = [];
  const base = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return (responses[bodies.length - 1] ?? chatReply)();
  }) as typeof fetch;
  const model = createOpenAICompatible({ name: "qwen", baseURL: "http://x", apiKey: "k", fetch: withToolMedia(base, "openai", modelKey, load) })("m");
  await generateText({ model, messages, maxRetries: 0 });
  return bodies;
}

const whole = (path: string) => watchVideoModelOutput({ kind: "whole", filePath: path, path, mediaType: "video/mp4", size: 1024 * 1024, probe: { duration: 83.4, width: 1280, height: 720 } }, false);

beforeEach(() => {
  load.mockClear();
  nativeVideoRejected.clear();
  mediaLimits.clear();
});

const framesOutput = (path: string, n: number, tag: string) =>
  watchVideoModelOutput(
    {
      kind: "frames",
      filePath: path,
      size: 2048,
      probe: { duration: 10, width: 640, height: 360 },
      frames: Array.from({ length: n }, (_, i) => ({ time: i, data: `${tag}${i}` })),
    },
    false,
  );

describe("WatchVideo on an OpenAI-compatible endpoint", () => {
  it("sends the whole video as a video_url part after the tool message", async () => {
    const [body] = await sendOpenAI(conversation(whole("C:\\clips\\demo.mp4")));
    const msgs = body.messages as { role: string; content: unknown }[];
    expect(msgs[2]).toMatchObject({ role: "tool" });
    expect(msgs[2].content).toContain("Watching the whole video C:\\clips\\demo.mp4 (1:23.4, 1280×720, 1 MB)");
    expect(msgs[2].content).toContain("[The video is attached in the next message.]");
    expect(msgs[2].content).not.toContain("⟦nyxs-video");
    expect(msgs[3]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What the tool calls above returned:" },
        { type: "video_url", video_url: { url: "data:video/mp4;base64,B64(C:\\clips\\demo.mp4)" } },
      ],
    });
    expect(load).toHaveBeenCalledWith("C:\\clips\\demo.mp4");
  });

  it("merges the media into the user message that already follows", async () => {
    const [body] = await sendOpenAI(conversation(whole("v.mp4"), "What happens at the end?"));
    const msgs = body.messages as { role: string; content: unknown }[];
    expect(msgs).toHaveLength(4);
    expect(msgs[3].content).toEqual([
      { type: "text", text: "What the tool calls above returned:" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,B64(v.mp4)" } },
      { type: "text", text: "What happens at the end?" },
    ]);
  });

  it("keeps only the two latest videos attached", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Watch them" }];
    for (const id of ["a", "b", "c"]) {
      messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "WatchVideo", input: {} }] });
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "WatchVideo", output: whole(`${id}.mp4`) as never }] });
    }
    const [body] = await sendOpenAI(messages);
    const tools = (body.messages as { role: string; content: string }[]).filter((m) => m.role === "tool");
    expect(tools[0].content).toContain("no longer attached");
    expect(tools[1].content).toContain("attached in the next message");
    expect(tools[2].content).toContain("attached in the next message");
    expect(load.mock.calls.map((c) => c[0])).toEqual(["b.mp4", "c.mp4"]);
  });

  it("moves a tool's images out of the JSON text into image_url parts", async () => {
    const frames = watchVideoModelOutput(
      { kind: "frames", filePath: "a.mp4", size: 2048, probe: { duration: 10, width: 640, height: 360 }, frames: [{ time: 1.25, data: "AAA" }, { time: 6.25, data: "BBB" }] },
      false,
    );
    const [body] = await sendOpenAI(conversation(frames));
    const msgs = body.messages as { role: string; content: unknown }[];
    expect(msgs[2].content).toBe(
      "Video a.mp4 (0:10.0, 640×360, 2 KB): 2 frames, attached below in order (1 at 0:01.3, 2 at 0:06.3).\n[The images this tool returned are in the next message.]",
    );
    expect(msgs[2].content).not.toContain("AAA");
    expect(msgs[3].content).toEqual([
      { type: "text", text: "What the tool calls above returned:" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
    ]);
  });

  it("retries without the video when the endpoint turns it down, and remembers it", async () => {
    const reject = () => new Response(JSON.stringify({ error: { message: "Unsupported content type: video_url" } }), { status: 400 });
    const bodies = await sendOpenAI(conversation(whole("v.mp4")), [reject, chatReply], "minimax/MiniMax-M3.1-Flash");
    expect(bodies).toHaveLength(2);
    const retried = bodies[1].messages as { role: string; content: unknown }[];
    expect(retried[2].content).toContain("didn't accept this video (HTTP 400");
    expect(retried[2].content).toContain('mode "frames"');
    expect(retried).toHaveLength(3);
    expect(nativeVideoRejected.has("minimax/MiniMax-M3.1-Flash")).toBe(true);
    // From then on the request goes without it from the start.
    const next = await sendOpenAI(conversation(whole("v.mp4")), [chatReply], "minimax/MiniMax-M3.1-Flash");
    expect(next).toHaveLength(1);
    expect(JSON.stringify(next[0])).not.toContain("video_url");
  });

  it("keeps within the images per request an endpoint names, newest first, and remembers it", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Watch it twice" }];
    for (const [id, tag] of [["a", "A"], ["b", "B"]]) {
      messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "WatchVideo", input: {} }] });
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "WatchVideo", output: framesOutput("v.mp4", 6, tag) as never }] });
    }
    const vllm = () =>
      new Response(JSON.stringify({ object: "error", message: "At most 8 image(s) may be provided in one prompt. Set `--limit-mm-per-prompt` to increase this limit." }), { status: 400 });
    const bodies = await sendOpenAI(messages, [vllm, chatReply], "nvidia/minimaxai/minimax-m3.1-flash");
    expect(bodies).toHaveLength(2);
    const urls = (b: Body) => [...JSON.stringify(b).matchAll(/data:image\/jpeg;base64,(\w+)/g)].map((m) => m[1]);
    expect(urls(bodies[0])).toHaveLength(12);
    expect(urls(bodies[1])).toEqual(["A4", "A5", "B0", "B1", "B2", "B3", "B4", "B5"]);
    const tools = (bodies[1].messages as { role: string; content: string }[]).filter((m) => m.role === "tool");
    expect(tools[0].content).toContain("4 images this tool returned were left out: the model's endpoint takes at most 8 per request");
    expect(tools[1].content).not.toContain("left out");
    expect(mediaLimits.get("nvidia/minimaxai/minimax-m3.1-flash")).toEqual({ image: 8 });
    // The next request already keeps to it.
    const next = await sendOpenAI(messages, [chatReply], "nvidia/minimaxai/minimax-m3.1-flash");
    expect(next).toHaveLength(1);
    expect(urls(next[0])).toHaveLength(8);
  });

  it("keeps within the videos per request an endpoint names, without giving up on video", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Watch both" }];
    for (const id of ["a", "b"]) {
      messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "WatchVideo", input: {} }] });
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "WatchVideo", output: whole(`${id}.mp4`) as never }] });
    }
    const vllm = () => new Response(JSON.stringify({ object: "error", message: "At most 1 video(s) may be provided in one prompt." }), { status: 400 });
    const bodies = await sendOpenAI(messages, [vllm, chatReply], "vllm/qwen3.8-vl");
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[0]).match(/"type":"video_url"/g)).toHaveLength(2);
    expect(JSON.stringify(bodies[1]).match(/"type":"video_url"/g)).toHaveLength(1);
    expect(JSON.stringify(bodies[1])).toContain("B64(b.mp4)");
    expect(nativeVideoRejected.has("vllm/qwen3.8-vl")).toBe(false);
    expect(mediaLimits.get("vllm/qwen3.8-vl")).toEqual({ video: 1 });
  });

  it("sees a limit an endpoint states in its stream's first event", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Watch it twice" }];
    for (const [id, tag] of [["a", "A"], ["b", "B"]]) {
      messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "WatchVideo", input: {} }] });
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "WatchVideo", output: framesOutput("v.mp4", 6, tag) as never }] });
    }
    const sse = (events: unknown[]) =>
      new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    const limitEvent = () => sse([{ error: { message: "At most 8 image(s) may be provided in one prompt.", type: "BadRequestError", code: 400 } }]);
    const answer = () =>
      sse([
        { id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "four colours" }, finish_reason: null }] },
        { id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ]);
    const bodies: Body[] = [];
    const responses = [limitEvent, answer];
    const base = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responses[bodies.length - 1]();
    }) as typeof fetch;
    const model = createOpenAICompatible({ name: "nvidia", baseURL: "http://x", apiKey: "k", fetch: withToolMedia(base, "openai", "nvidia/mm", load) })("m");
    const { streamText } = await import("ai");
    const result = streamText({ model, messages, maxRetries: 0 });
    expect(await result.text).toBe("four colours");
    expect(bodies).toHaveLength(2);
    expect(mediaLimits.get("nvidia/mm")).toEqual({ image: 8 });
  });

  it("hands an unrelated stream error to the SDK untouched", async () => {
    const sse = new Response(`data: ${JSON.stringify({ error: { message: "Rate limit reached" } })}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    let calls = 0;
    const base = (async () => {
      calls++;
      return sse;
    }) as typeof fetch;
    const model = createOpenAICompatible({ name: "nvidia", baseURL: "http://x", apiKey: "k", fetch: withToolMedia(base, "openai", "nvidia/mm2", load) })("m");
    const { streamText } = await import("ai");
    const errors: unknown[] = [];
    const result = streamText({ model, messages: conversation(whole("v.mp4")), maxRetries: 0, onError: ({ error }) => void errors.push(error) });
    await result.consumeStream();
    expect(calls).toBe(1);
    expect(JSON.stringify(errors)).toContain("Rate limit reached");
    expect(nativeVideoRejected.has("nvidia/mm2")).toBe(false);
  });

  it("doesn't give up on video over an error that isn't about it", async () => {
    let calls = 0;
    const base = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "This model's maximum context length is 32768 tokens" } }), { status: 400 });
    }) as typeof fetch;
    const model = createOpenAICompatible({ name: "qwen", baseURL: "http://x", apiKey: "k", fetch: withToolMedia(base, "openai", "qwen/ctx", load) })("m");
    await expect(generateText({ model, messages: conversation(whole("v.mp4")), maxRetries: 0 })).rejects.toThrow(/maximum context length/);
    expect(calls).toBe(1);
    expect(nativeVideoRejected.has("qwen/ctx")).toBe(false);
  });

  it("leaves requests without media untouched", async () => {
    const [body] = await sendOpenAI(conversation({ type: "text", value: "plain result" }));
    expect((body.messages as unknown[]).length).toBe(3);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("WatchVideo on Gemini", () => {
  it("puts the video as inlineData next to the function response", async () => {
    let body: Body | undefined;
    const base = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return geminiReply();
    }) as typeof fetch;
    const model = createGoogleGenerativeAI({ apiKey: "k", fetch: withToolMedia(base, "google", "google/gemini-3.8-flash", load) })("gemini-3.8-flash");
    await generateText({ model, messages: conversation(whole("clip.webm")), maxRetries: 0 });
    const parts = (body!.contents as { parts: Record<string, unknown>[] }[]).flatMap((c) => c.parts);
    const at = parts.findIndex((p) => "functionResponse" in p);
    expect(JSON.stringify(parts[at])).toContain("attached in the next message");
    expect(parts[at + 1]).toEqual({ inlineData: { mimeType: "video/mp4", data: "B64(clip.webm)" } });
  });
});

describe("Frame timing", () => {
  it("spreads frames over the middle of even slices", () => {
    expect(frameTimes(80, 4)).toEqual([10, 30, 50, 70]);
    expect(frameTimes(80, 2, 20, 40)).toEqual([25, 35]);
    expect(frameTimes(10, 1)).toEqual([5]);
  });

  it("clamps the range and the count", () => {
    expect(frameTimes(10, 2, 8, 50)).toEqual([8.5, 9.5]);
    expect(frameTimes(10, 100)).toHaveLength(24);
    expect(frameTimes(0, 8)).toEqual([0]);
  });

  it("formats timestamps", () => {
    expect(formatTimestamp(5.04)).toBe("0:05.0");
    expect(formatTimestamp(83.4)).toBe("1:23.4");
    expect(formatTimestamp(3725)).toBe("1:02:05.0");
  });
});

describe("Which models watch whole videos", () => {
  const m = (provider: string, apiModel: string) => ({ id: `${provider}:${apiModel}`, provider, apiModel, name: apiModel, description: "" }) as never;

  it("reads video from models.dev's input modalities", () => {
    setRegistryIndex(
      compactRegistry({
        alibaba: { models: { "qwen3.8-flash-next": { modalities: { input: ["text", "image", "video"] } } } },
        minimax: { models: { "minimax-m3.1-flash": { modalities: { input: ["text", "image", "video"] } } } },
        mistral: { models: { "pixtral-large": { modalities: { input: ["text", "image"] } } } },
      }),
    );
    expect(registryVideo("qwen", "qwen3.8-flash-next")).toBe(true);
    expect(registryVideo("custom", "MiniMaxAI/MiniMax-M3.1-Flash")).toBe(true);
    expect(registryVideo("mistral", "pixtral-large")).toBe(false);
    expect(supportsVideo(m("minimax", "MiniMax-M3.1-Flash"))).toBe(true);
    setRegistryIndex(null);
  });

  it("falls back to names, and only where Nyxs can send a video", () => {
    expect(supportsVideo(m("qwen", "qwen3.8-flash-next"))).toBe(true);
    expect(supportsVideo(m("qwen", "qwen-vl-max"))).toBe(true);
    expect(supportsVideo(m("minimax", "MiniMax-M3.1-Flash-Preview"))).toBe(true);
    expect(supportsVideo(m("google", "gemini-3.8-flash"))).toBe(true);
    expect(supportsVideo(m("deepseek", "deepseek-chat"))).toBe(false);
    // NVIDIA samples a single frame of a video: frames do better there.
    expect(supportsVideo(m("nvidia", "minimaxai/minimax-m3.1-flash"))).toBe(false);
    // The Anthropic protocol has no video, whatever the model.
    expect(supportsVideo(m("minimax-anthropic", "MiniMax-M3.1-Flash"))).toBe(false);
    expect(supportsVideo(m("anthropic", "claude-opus-5-5"))).toBe(false);
  });
});

describe("Attached videos", () => {
  it("tell the agent to watch them with WatchVideo", () => {
    const text = withDocuments("Mira esto", [{ name: "demo.mp4", size: 1000, mime: "video/mp4", path: "C:\\Users\\u\\.nyxs\\attachments\\1\\demo.mp4" }]);
    expect(text).toContain("open it with WatchVideo");
  });

  it("weigh a whole video in the context estimate", () => {
    const light = estimateMessageTokens(conversation({ type: "text", value: "plain result" }));
    const heavy = estimateMessageTokens(conversation(whole("v.mp4")));
    expect(heavy - light).toBeGreaterThan(15_000);
  });
});

describe("videoMarker", () => {
  it("survives paths with spaces and quotes", async () => {
    const path = 'C:\\My clips\\"odd" name.mp4';
    const [body] = await sendOpenAI(conversation({ type: "text", value: `x ${videoMarker(path, "video/mp4")}` }));
    expect(load).toHaveBeenCalledWith(path);
    expect(JSON.stringify(body)).toContain("video_url");
  });
});
