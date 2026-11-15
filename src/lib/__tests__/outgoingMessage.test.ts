import { describe, it, expect } from "vitest";
import type { SendPayload } from "@/components/ui/claude-style-chat-input";
import { outgoingMessage } from "@/lib/outgoingMessage";

const payload = (message: string, pasted: string[] = []): SendPayload => ({
  message,
  files: [],
  pastedContent: pasted.map((content, i) => ({ id: `p${i}`, content, timestamp: new Date(0) })),
  model: "m",
  isThinkingEnabled: false,
});

describe("outgoingMessage", () => {
  it("sends nothing for an empty message", async () => {
    expect(await outgoingMessage(payload("   "))).toBeNull();
  });

  it("shows the typed text and gives the model the pasted text too", async () => {
    const out = (await outgoingMessage(payload("  arregla esto ", ["error en la línea 3"])))!;
    expect(out.userMessage).toMatchObject({ role: "user", content: "arregla esto", pasted: ["error en la línea 3"] });
    expect(out.modelText).toBe("arregla esto\n\nerror en la línea 3");
    expect(out.titleText).toBe("arregla esto");
    expect(out.modelImages).toBeUndefined();
  });

  it("shows a command's label instead of its expanded text", async () => {
    const out = (await outgoingMessage(payload("Read the plan.md file and apply it"), "Apply plan"))!;
    expect(out.userMessage.content).toBe("Apply plan");
    expect(out.modelText).toBe("Read the plan.md file and apply it");
  });

  it("names the chat after the pasted text when nothing was typed", async () => {
    expect((await outgoingMessage(payload("", ["un log largo"])))!.titleText).toBe("un log largo");
  });
});
