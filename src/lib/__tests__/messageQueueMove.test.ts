import { describe, expect, it } from "vitest";
import { enqueue, moveItem, type QueueMap } from "@/lib/messageQueue";

type P = { message: string };
const queueOf = (...ids: string[]) => ids.reduce<QueueMap<P>>((m, id) => enqueue(m, "c", { id, payload: { message: id } }), {});
const order = (m: QueueMap<P>) => m.c.items.map((i) => i.id);

describe("moving a queued message", () => {
  it("puts it at the new place and keeps the rest in order", () => {
    expect(order(moveItem(queueOf("a", "b", "c"), "c", "c", 0))).toEqual(["c", "a", "b"]);
    expect(order(moveItem(queueOf("a", "b", "c"), "c", "a", 2))).toEqual(["b", "c", "a"]);
  });

  it("clamps the place and leaves the queue alone for an unknown message or the same place", () => {
    const q = queueOf("a", "b");
    expect(order(moveItem(q, "c", "a", 9))).toEqual(["b", "a"]);
    expect(order(moveItem(q, "c", "b", -3))).toEqual(["b", "a"]);
    expect(moveItem(q, "c", "zz", 0)).toBe(q);
    expect(moveItem(q, "c", "a", 0)).toBe(q);
  });
});
