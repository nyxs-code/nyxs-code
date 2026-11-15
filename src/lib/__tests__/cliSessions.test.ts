import { describe, expect, it } from "vitest";
import { chatFromCliSession } from "@/lib/cliSessions";
import { sessionIdOf } from "@/lib/claudeCodeText";

describe("chatFromCliSession", () => {
  const session = { id: "abc-123", title: "Fix the login flow that breaks after the token expires", modifiedAt: 1000, messageCount: 4, entrypoint: "cli" };
  const chat = chatFromCliSession({
    chatId: "brave-otter",
    workspace: "D:\\proj",
    session,
    messages: [
      { role: "user", text: "Fix the login" },
      { role: "assistant", text: "Looking." },
      { role: "user", text: "Also the logout" },
      { role: "assistant", text: "Both fixed." },
    ],
    model: "claude-code:opus",
    permissionMode: "ask",
  });

  it("keeps the conversation and a short title", () => {
    expect(chat.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Fix the login"],
      ["assistant", "Looking."],
      ["user", "Also the logout"],
      ["assistant", "Both fixed."],
    ]);
    expect(chat.title.length).toBeLessThanOrEqual(35);
    expect(chat).toMatchObject({ workspace: "D:\\proj", model: "claude-code:opus" });
  });

  it("puts the CLI session id on the last reply, so the next message resumes it", () => {
    const last = chat.messages[3];
    expect(sessionIdOf({ role: "assistant", content: last.content, messages: last.responseMessages })).toBe("abc-123");
    expect(chat.messages[1].responseMessages).toBeUndefined();
  });
});
