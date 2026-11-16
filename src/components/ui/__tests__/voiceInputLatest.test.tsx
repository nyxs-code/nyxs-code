// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TranscribeErrorReason } from "@/lib/transcribe";

let finish: (text: string) => void = () => {};
let fail: (reason: unknown) => void = () => {};
let micError: TranscribeErrorReason | null = null;
vi.mock("@/lib/transcribe", () => ({
  MAX_SECONDS: 60,
  TranscribeError: class extends Error {
    reason: string;
    constructor(reason: string, message?: string) { super(message ?? reason); this.reason = reason; }
  },
  VoiceRecorder: class {
    async start() { if (micError) throw new TranscribeError(micError); }
    async stop() { return new Blob(); }
    level() { return 0; }
    cancel() {}
  },
  transcribeBlob: () => new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; }),
  listMicrophones: async () => [],
  ensureMicPermission: async () => {},
}));

// Live dictation: off unless a test turns it on, as with a backend that doesn't have it.
const live = vi.hoisted(() => ({ available: false, onText: (_t: string) => {}, final: "" }));
vi.mock("@/lib/transcribeStream", () => {
  class StreamUnavailable extends Error {}
  return {
    StreamUnavailable,
    StreamingDictation: class {
      constructor(onText: (t: string) => void) { live.onText = onText; }
      async start() { if (!live.available) throw new StreamUnavailable("no stream"); }
      async stop() { return live.final; }
      level() { return 0; }
      cancel() {}
    },
  };
});
vi.mock("@/lib/filePaths", () => ({ currentWorkspace: () => "C:/proj/optimicer" }));

const { useVoiceInput } = await import("@/components/ui/chat-input/useVoiceInput");
const { TranscribeError } = await import("@/lib/transcribe");

describe("dictation", () => {
  it("hands the transcript to the chat box as it is when it arrives, not as it was when dictation stopped", async () => {
    const before = vi.fn();
    const after = vi.fn();
    const textareaRef = { current: null };
    const { result, rerender } = renderHook(({ onTranscript }) => useVoiceInput({ textareaRef, onTranscript }), { initialProps: { onTranscript: before } });
    await act(async () => { result.current.onMicClick({ detail: 0 } as never); });
    await act(async () => { void result.current.stopVoice("send"); });
    // The user typed on while it was being transcribed: the box's handler is a newer one.
    rerender({ onTranscript: after });
    await act(async () => finish("y algo más"));
    expect(after).toHaveBeenCalledWith("y algo más", "send");
    expect(before).not.toHaveBeenCalled();
  });

  it("says why the dictation failed instead of failing silently", async () => {
    live.available = false;
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ textareaRef: { current: null }, onTranscript: vi.fn(), onError }));
    await act(async () => { result.current.onMicClick({ detail: 0 } as never); });
    await act(async () => { void result.current.stopVoice(false); });
    await act(async () => { fail(new TranscribeError("not-signed-in")); });
    expect(onError).toHaveBeenCalledWith("not-signed-in");
  });

  it("says it heard nothing when the transcript comes back empty", async () => {
    live.available = false;
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ textareaRef: { current: null }, onTranscript: vi.fn(), onError }));
    await act(async () => { result.current.onMicClick({ detail: 0 } as never); });
    await act(async () => { void result.current.stopVoice(false); });
    await act(async () => { finish("   "); });
    expect(onError).toHaveBeenCalledWith("empty");
  });

  it("says when the microphone cannot be opened", async () => {
    live.available = false;
    micError = "no-mic";
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ textareaRef: { current: null }, onTranscript: vi.fn(), onError }));
    await act(async () => { result.current.onMicClick({ detail: 0 } as never); });
    expect(onError).toHaveBeenCalledWith("no-mic");
    expect(result.current.voiceState).toBe("idle");
    micError = null;
  });

  it("shows the words while the user speaks and hands over the final text when live dictation is there", async () => {
    vi.resetModules();
    live.available = true;
    live.final = "abre los ajustes";
    const { useVoiceInput: fresh } = await import("@/components/ui/chat-input/useVoiceInput");
    const onTranscript = vi.fn();
    const onLiveText = vi.fn();
    const { result } = renderHook(() => fresh({ textareaRef: { current: null }, onTranscript, onLiveText }));
    await act(async () => { result.current.onMicClick({ detail: 0 } as never); });
    expect(result.current.voiceState).toBe("recording");
    act(() => live.onText("abre los"));
    expect(onLiveText).toHaveBeenLastCalledWith("abre los");
    await act(async () => { await result.current.stopVoice(false); });
    expect(onTranscript).toHaveBeenCalledWith("abre los ajustes", false);
    expect(result.current.voiceState).toBe("idle");
  });
});
