import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_SOUND_IDS, playNotificationSound } from "@/lib/notificationSounds";
import { resolveNotificationSound } from "@/lib/notificationPrefs";

const param = () => ({ setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });

class FakeAudioContext {
  static oscillators = 0;
  state = "running";
  currentTime = 0;
  destination = {};
  createOscillator() {
    FakeAudioContext.oscillators++;
    const node = { type: "sine", frequency: param(), start: vi.fn(), stop: vi.fn(), connect: (n: unknown) => n };
    return node;
  }
  createGain() {
    return { gain: param(), connect: (n: unknown) => n };
  }
  resume() {
    return Promise.resolve();
  }
}

describe("notification sounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plays notes for every sound but none", () => {
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    for (const id of NOTIFICATION_SOUND_IDS) {
      FakeAudioContext.oscillators = 0;
      playNotificationSound(id);
      if (id === "none") expect(FakeAudioContext.oscillators).toBe(0);
      else expect(FakeAudioContext.oscillators, id).toBeGreaterThan(0);
    }
  });

  it("falls back to the default for an unknown saved sound", () => {
    expect(resolveNotificationSound("marimba")).toBe("marimba");
    expect(resolveNotificationSound("gone")).toBe("classic");
    expect(resolveNotificationSound(undefined)).toBe("classic");
  });
});
