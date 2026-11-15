import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/components/Message";
import { OLD_TOOL_IMAGE_NOTE, withoutOldToolImages } from "@/lib/toolImageHistory";

const JPEG = "A".repeat(200_000);

/** An assistant turn whose tool call took a screenshot (as Computer's or BrowserScreenshot's). */
function screenshotTurn(n: number, kind: "image-data" | "file-data" = "image-data"): ChatMessage {
  return {
    id: `a${n}`,
    role: "assistant",
    content: `step ${n}`,
    responseMessages: [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${n}`, toolName: "Computer", input: { action: "screenshot" } }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `c${n}`,
            toolName: "Computer",
            output: { type: "content", value: [{ type: "text", text: `shot ${n}` }, { type: kind, data: JPEG, mediaType: "image/jpeg" }] },
          },
        ],
      },
    ],
  } as ChatMessage;
}

const images = (msgs: ChatMessage[]) => JSON.stringify(msgs).split(JPEG).length - 1;

describe("withoutOldToolImages", () => {
  it("keeps the latest screenshots and leaves a note for the model in place of the older ones", () => {
    const user: ChatMessage = { id: "u", role: "user", content: "hola", images: [{ name: "mine.png", dataUrl: `data:image/png;base64,${JPEG}` } as never] };
    const chat = [user, ...Array.from({ length: 10 }, (_, i) => screenshotTurn(i, i % 2 ? "file-data" : "image-data"))];
    const saved = withoutOldToolImages(chat, 3);
    // The user's own image stays; of the ten screenshots, the last three.
    expect(images(saved)).toBe(1 + 3);
    expect(JSON.stringify(saved).length).toBeLessThan(JSON.stringify(chat).length / 2);
    const old = saved[1].responseMessages![1] as { content: { output: { value: unknown[] } }[] };
    expect(old.content[0].output.value).toEqual([{ type: "text", text: "shot 0" }, { type: "text", text: OLD_TOOL_IMAGE_NOTE }]);
    expect(saved[10]).toBe(chat[10]);
    // What the chat shows is untouched.
    expect(saved.map((m) => m.content)).toEqual(chat.map((m) => m.content));
  });

  it("returns the same chat when there's nothing to drop", () => {
    const chat = [screenshotTurn(1), screenshotTurn(2)];
    expect(withoutOldToolImages(chat, 3)).toBe(chat);
  });
});
