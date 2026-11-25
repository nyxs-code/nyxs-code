// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Just enough of Web Audio to see what the ambience builds and when it stops. */
const audio = vi.hoisted(() => {
  const made: FakeCtx[] = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime: vi.fn(), cancelScheduledValues() {} });
  const node = () => {
    const n = { connect: (to: unknown) => to, disconnect() {}, start: vi.fn(), stop: vi.fn() };
    return n;
  };
  class FakeCtx {
    currentTime = 0;
    sampleRate = 8000;
    state = "running";
    destination = node();
    sources: ReturnType<typeof node>[] = [];
    close = vi.fn(async () => {});
    suspend = vi.fn(async () => {});
    resume = vi.fn(async () => {});
    constructor() {
      made.push(this);
    }
    createBuffer(_c: number, length: number) {
      const data = new Float32Array(length);
      return { duration: length / 8000, getChannelData: () => data };
    }
    createBufferSource() {
      const s = { ...node(), buffer: null as unknown, loop: false };
      this.sources.push(s);
      return s;
    }
    createOscillator() {
      const o = { ...node(), frequency: param() };
      this.sources.push(o);
      return o;
    }
    createBiquadFilter() {
      return { ...node(), type: "", frequency: param(), Q: param() };
    }
    createGain() {
      return { ...node(), gain: param() };
    }
  }
  return { made, FakeCtx };
});

const { setAmbientPaused, startAmbient, stopAmbient } = await import("@/lib/ambientSound");
const { ThemeSound } = await import("@/components/ThemeSound");
const { APPEARANCE_KEY, setAppearance } = await import("@/lib/appearance");

beforeEach(() => {
  vi.stubGlobal("AudioContext", audio.FakeCtx);
  vi.useFakeTimers();
  audio.made.length = 0;
});
afterEach(() => {
  stopAmbient();
  vi.runAllTimers();
  cleanup();
  localStorage.removeItem(APPEARANCE_KEY);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the theme sound", () => {
  it("builds each ambience and starts its sounds", () => {
    for (const kind of ["rain", "campfire", "ambience"] as const) {
      startAmbient(kind, "medium");
      const ctx = audio.made.at(-1)!;
      expect(ctx.sources.length).toBeGreaterThan(0);
      expect(ctx.sources.some((s) => s.start.mock.calls.length > 0)).toBe(true);
    }
  });

  it("only changes the volume when the same ambience plays, and frees the audio when stopped", () => {
    startAmbient("rain", "low");
    startAmbient("rain", "high");
    expect(audio.made).toHaveLength(1);
    stopAmbient();
    vi.advanceTimersByTime(600);
    expect(audio.made[0].close).toHaveBeenCalled();
  });

  it("goes quiet while the window is hidden", () => {
    startAmbient("campfire", "medium");
    setAmbientPaused(true);
    expect(audio.made[0].suspend).toHaveBeenCalled();
    setAmbientPaused(false);
    expect(audio.made[0].resume).toHaveBeenCalled();
  });

  it("follows the setting", () => {
    render(<ThemeSound />);
    expect(audio.made).toHaveLength(0);
    act(() => setAppearance({ themeSound: "rain" }));
    expect(audio.made).toHaveLength(1);
    act(() => setAppearance({ themeSound: "off" }));
    vi.advanceTimersByTime(600);
    expect(audio.made[0].close).toHaveBeenCalled();
  });
});
