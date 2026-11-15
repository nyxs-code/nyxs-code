import { describe, expect, it } from "vitest";
import {
  clearQueue,
  editItem,
  enqueue,
  nextToSend,
  prioritize,
  promote,
  readyToSend,
  removeItem,
  setPaused,
  type QueueMap,
} from "@/lib/messageQueue";

type P = { message: string };
const item = (id: string, message = id) => ({ id, payload: { message } });

function build(...ids: string[]): QueueMap<P> {
  return ids.reduce<QueueMap<P>>((m, id) => enqueue(m, "c", item(id)), {});
}

describe("message queue", () => {
  it("sends queued messages in order", () => {
    let m = build("a", "b", "c");
    const sent: string[] = [];
    for (let next = nextToSend(m, "c", false); next; next = nextToSend(m, "c", false)) {
      sent.push(next.id);
      m = removeItem(m, "c", next.id);
    }
    expect(sent).toEqual(["a", "b", "c"]);
    expect(m).toEqual({});
  });

  it("offers the next message of every chat that isn't busy or paused", () => {
    let m = enqueue(enqueue(build("a", "b"), "d", item("x")), "e", item("y"));
    m = setPaused(m, "e", true);
    expect(readyToSend(m, (id) => id === "d")).toEqual([{ chatId: "c", item: item("a") }]);
    expect(readyToSend(m, () => false).map((r) => r.chatId)).toEqual(["c", "d"]);
  });

  it("waits while the chat is busy or paused", () => {
    const m = build("a");
    expect(nextToSend(m, "c", true)).toBeNull();
    expect(nextToSend(setPaused(m, "c", true), "c", false)).toBeNull();
    expect(nextToSend(m, null, false)).toBeNull();
    expect(nextToSend(m, "other", false)).toBeNull();
  });

  it("keeps queues per chat", () => {
    const m = enqueue(build("a"), "d", item("x"));
    expect(nextToSend(m, "c", false)?.id).toBe("a");
    expect(nextToSend(m, "d", false)?.id).toBe("x");
  });

  it("steer puts a message first and resumes a paused queue", () => {
    const m = prioritize(setPaused(build("a", "b"), "c", true), "c", item("steer"));
    expect(m.c.paused).toBe(false);
    expect(m.c.items.map((i) => i.id)).toEqual(["steer", "a", "b"]);
  });

  it("send now promotes an existing item without duplicating it", () => {
    const m = promote(build("a", "b", "c"), "c", "c");
    expect(m.c.items.map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(promote(m, "c", "missing")).toBe(m);
  });

  it("edits the text of a queued message", () => {
    const m = editItem(
      enqueue({}, "c", { id: "a", payload: { message: "old" }, displayText: "Shown" }),
      "c",
      "a",
      "new",
    );
    expect(m.c.items[0].payload.message).toBe("new");
    expect(m.c.items[0].displayText).toBeUndefined();
  });

  it("removing the last item clears the pause", () => {
    let m = setPaused(build("a"), "c", true);
    expect(m.c.paused).toBe(true);
    m = removeItem(m, "c", "a");
    expect(m).toEqual({});
  });

  it("does not pause an empty queue", () => {
    const m: QueueMap<P> = {};
    expect(setPaused(m, "c", true)).toBe(m);
  });

  it("clear empties the queue", () => {
    expect(clearQueue(setPaused(build("a", "b"), "c", true), "c")).toEqual({});
  });
});
