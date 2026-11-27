import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/components/Message";
import type { CloudEvent } from "@/lib/cloud/cloudApi";
import { applyCloudEvents, threadStatusOfCloud } from "../cloudThreads";

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): CloudEvent => ({ seq, at: "2026-11-26T10:00:00Z", type, data });
const idFor = (seq: number) => `m${seq}`;
const first: ChatMessage = { id: "u1", role: "user", content: "Fix the login" };

describe("applyCloudEvents", () => {
  it("writes a turn as a local one would: text, tool cards and their ends", () => {
    const { messages, seq, effects } = applyCloudEvents(
      [first],
      [
        ev(1, "start", { turn: 1 }),
        ev(2, "text", { text: "Looking at it." }),
        ev(3, "tool", { id: "t1", name: "Read", detail: "src/login.ts" }),
        ev(4, "tool_result", { id: "t1", name: "Read", output: "export…" }),
        ev(5, "text", { text: " Fixed." }),
        ev(6, "report", { text: "Fixed the redirect", status: "review" }),
        ev(7, "done", { status: "review", preview: "Fixed the redirect", prUrl: "https://github.com/me/shop/pull/3", branch: "nyxs/fix-1" }),
      ],
      0,
      idFor,
    );
    expect(seq).toBe(7);
    expect(messages).toHaveLength(2);
    const reply = messages[1];
    expect(reply.id).toBe("m1");
    expect(reply.streaming).toBe(false);
    expect(reply.content).toBe("Looking at it.\n\n⟦TOOL⟧t1⟦SEP⟧Read⟦SEP⟧src/login.ts⟦/TOOL⟧\n\n⟦TOOLEND⟧t1⟦SEP⟧ok⟦/TOOLEND⟧ Fixed.");
    expect(reply.toolData?.t1).toEqual({ name: "Read", detail: "src/login.ts", output: "export…" });
    expect(effects).toEqual([
      { kind: "report", text: "Fixed the redirect", status: "review" },
      { kind: "done", status: "review", preview: "Fixed the redirect", prUrl: "https://github.com/me/shop/pull/3", branch: "nyxs/fix-1" },
    ]);
  });

  it("skips what it applied already and opens a new reply for the next turn", () => {
    const once = applyCloudEvents([first], [ev(1, "start"), ev(2, "text", { text: "A" }), ev(3, "done", { status: "needs_input" })], 0, idFor);
    const again = applyCloudEvents(once.messages, [ev(2, "text", { text: "A" }), ev(3, "done", { status: "needs_input" })], once.seq, idFor);
    expect(again.messages).toBe(once.messages);
    expect(again.effects).toEqual([]);
    const follow: ChatMessage = { id: "u2", role: "user", content: "Use option B" };
    const next = applyCloudEvents([...once.messages, follow], [ev(4, "start"), ev(5, "text", { text: "On it" })], once.seq, idFor);
    expect(next.messages.map((m) => m.id)).toEqual(["u1", "m1", "u2", "m4"]);
    expect(next.messages[3].streaming).toBe(true);
  });

  it("shows errors in the reply and passes statuses on", () => {
    const { messages, effects } = applyCloudEvents([first], [ev(1, "status", { status: "working" }), ev(2, "error", { message: "clone failed\nno access" }), ev(3, "report", { text: "?", status: "odd" })], 0, idFor);
    expect(messages[1].content).toBe("> clone failed\n> no access");
    expect(effects).toEqual([{ kind: "status", status: "working" }, { kind: "report", text: "?", status: "review" }]);
  });
});

describe("user events", () => {
  it("clear a message sent from here instead of showing it twice", () => {
    const sent: ChatMessage = { id: "u1", role: "user", content: "Message from the session…\n\n> Fix the login", cloudPending: true };
    const { messages } = applyCloudEvents([sent], [ev(1, "user", { text: "Fix the login", turn: 1 }), ev(2, "start"), ev(3, "text", { text: "On it" })], 0, idFor);
    expect(messages.map((m) => [m.id, m.role])).toEqual([["u1", "user"], ["m2", "assistant"]]);
    expect(messages[0].cloudPending).toBeUndefined();
  });

  it("add one this transcript lacks, under an id from its seq, once", () => {
    const turn1 = applyCloudEvents([], [ev(1, "user", { text: "Fix the login", turn: 1 }), ev(2, "start"), ev(3, "text", { text: "Done" }), ev(4, "done", { status: "review" })], 0, idFor);
    const follow = [ev(5, "user", { text: "Also the logout", turn: 2 }), ev(6, "start"), ev(7, "text", { text: "Also done" })];
    const turn2 = applyCloudEvents(turn1.messages, follow, turn1.seq, idFor);
    const again = applyCloudEvents(turn2.messages, follow, turn2.seq, idFor);
    expect(turn2.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ["m1", "user", "Fix the login"],
      ["m2", "assistant", "Done"],
      ["m5", "user", "Also the logout"],
      ["m6", "assistant", "Also done"],
    ]);
    expect(again.messages).toBe(turn2.messages);
  });
});

describe("a done with an error", () => {
  it("shows the error in the thread and hands it on, the status unchanged", () => {
    const { messages, effects } = applyCloudEvents(
      [first],
      [ev(1, "start"), ev(2, "text", { text: "Fixed." }), ev(3, "done", { status: "review", preview: "Fixed.", branch: "nyxs/x", error: "push failed" })],
      0,
      idFor,
    );
    expect(messages[1].content).toBe("Fixed.\n\n> push failed");
    expect(messages[1].streaming).toBe(false);
    expect(effects).toEqual([{ kind: "done", status: "review", preview: "Fixed.", branch: "nyxs/x", error: "push failed" }]);
  });
});

describe("threadStatusOfCloud", () => {
  it("maps the cloud's statuses to the app's", () => {
    expect(threadStatusOfCloud("queued")).toBe("working");
    expect(threadStatusOfCloud("stopped")).toBe("idle");
    expect(threadStatusOfCloud("needs_input")).toBe("needs_input");
    expect(threadStatusOfCloud("weird")).toBeUndefined();
  });
});
