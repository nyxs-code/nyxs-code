import { describe, expect, it } from "vitest";
import { PcmFramer, TranscriptAssembler } from "@/lib/transcribeStream";

const partial = (text: string, is_final = false, speech_final = false) => ({ text, is_final, speech_final });

describe("TranscriptAssembler", () => {
  it("builds the text the way xAI sends it: interim, locked chunks, then the whole utterance", () => {
    // The sequence xAI streamed for a Spanish clip while testing the integration.
    const a = new TranscriptAssembler();
    a.push(partial("Hola, revisa el"));
    expect(a.text).toBe("Hola, revisa el");
    a.push(partial("Hola, revisa el componente", true));
    a.push(partial("del panel de"));
    expect(a.text).toBe("Hola, revisa el componente del panel de");
    a.push(partial("del panel de cambios.", true));
    expect(a.text).toBe("Hola, revisa el componente del panel de cambios.");
    a.push(partial("Hola, revisa el componente del panel de cambios.", true, true));
    expect(a.text).toBe("Hola, revisa el componente del panel de cambios.");
    a.push(partial("Y luego"));
    expect(a.text).toBe("Hola, revisa el componente del panel de cambios. Y luego");
    a.push(partial("Y luego compílalo.", true, true));
    expect(a.text).toBe("Hola, revisa el componente del panel de cambios. Y luego compílalo.");
  });

  it("keeps the chunks when the utterance's end only carries its last piece", () => {
    const a = new TranscriptAssembler();
    a.push(partial("Abre los ajustes y", true));
    a.push(partial("cambia el sonido.", true, true));
    expect(a.text).toBe("Abre los ajustes y cambia el sonido.");
  });

  it("is empty until something is heard", () => {
    const a = new TranscriptAssembler();
    a.push(partial("", true, true));
    expect(a.text).toBe("");
  });
});

describe("PcmFramer", () => {
  const frames = (rate: number, seconds: number, value = 0.5) => {
    const out: Int16Array[] = [];
    const f = new PcmFramer(rate, (buf) => out.push(new Int16Array(buf)));
    // In odd-sized blocks, as the audio callback hands them over.
    const total = Math.round(rate * seconds);
    for (let i = 0; i < total; i += 1000) f.push(new Float32Array(Math.min(1000, total - i)).fill(value));
    f.flush();
    return out;
  };

  it("turns any device rate into 16 kHz frames of 100 ms", () => {
    for (const rate of [48000, 44100, 16000]) {
      const out = frames(rate, 1);
      const samples = out.reduce((n, f) => n + f.length, 0);
      expect(Math.abs(samples - 16000), `${rate} Hz`).toBeLessThanOrEqual(1);
      expect(out.slice(0, -1).every((f) => f.length === 1600), `${rate} Hz`).toBe(true);
    }
  });

  it("writes 16-bit samples, clamped", () => {
    // 0.5 × 32767, truncated by the Int16Array.
    expect(frames(48000, 0.1, 0.5)[0][0]).toBe(16383);
    expect(frames(48000, 0.1, 2)[0][0]).toBe(0x7fff);
    expect(frames(48000, 0.1, -2)[0][0]).toBe(-0x8000);
  });
});
