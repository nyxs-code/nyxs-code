import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ AUTH_BASE: "http://auth.test", getToken: vi.fn() }));

const { speechSeconds, isSilenceHallucination } = await import("@/lib/transcribe");

const RATE = 16000;

function noise(seconds: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out[i] = ((x / 2147483648) * 2 - 1) * amplitude;
  }
  return out;
}

function withTone(base: Float32Array, fromSec: number, seconds: number, amplitude: number): Float32Array {
  const out = base.slice();
  const start = Math.round(fromSec * RATE);
  const end = Math.min(out.length, start + Math.round(seconds * RATE));
  for (let i = start; i < end; i++) out[i] += Math.sin((2 * Math.PI * 220 * i) / RATE) * amplitude;
  return out;
}

describe("speechSeconds", () => {
  it("finds no speech in silence or in steady room noise", () => {
    expect(speechSeconds(new Float32Array(RATE * 3), RATE)).toBe(0);
    expect(speechSeconds(noise(3, 0.004), RATE)).toBe(0);
    expect(speechSeconds(noise(3, 0.05), RATE)).toBeLessThan(0.25);
  });

  it("measures how long someone actually spoke", () => {
    const spoken = speechSeconds(withTone(noise(3, 0.004), 1, 0.8, 0.2), RATE);
    expect(spoken).toBeGreaterThan(0.6);
    expect(spoken).toBeLessThan(1);
  });
});

describe("isSilenceHallucination", () => {
  it("recognises what Whisper invents for silent audio", () => {
    for (const t of ["you", "You.", "Thank you.", "¡Gracias!", "Subtítulos realizados por la comunidad de Amara.org", "Thanks for watching!", ""]) {
      expect(isSilenceHallucination(t), t).toBe(true);
    }
  });

  it("keeps real dictation", () => {
    for (const t of ["you should refactor this", "gracias por revisar el PR", "abre el archivo App.tsx"]) {
      expect(isSilenceHallucination(t), t).toBe(false);
    }
  });
});
