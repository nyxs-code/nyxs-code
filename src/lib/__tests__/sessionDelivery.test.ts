import { beforeEach, describe, expect, it } from "vitest";
import {
  deliveryIdIn,
  deliveryMarker,
  deliveryState,
  latestDeliveryId,
  markRead,
  markReplied,
  noteDelivery,
  resetDeliveriesForTests,
} from "@/lib/sessionDelivery";

beforeEach(resetDeliveriesForTests);

describe("a message sent to another session", () => {
  it("goes from queued to read to replied", () => {
    noteDelivery("m1", "a", "b", true);
    expect(deliveryState("m1")).toBe("queued");
    markRead(["m1"]);
    expect(deliveryState("m1")).toBe("read");
    // b writing back to a answers it; a writing to b again doesn't.
    markReplied("a", "b");
    expect(deliveryState("m1")).toBe("read");
    markReplied("b", "a");
    expect(deliveryState("m1")).toBe("replied");
    markRead(["m1"]);
    expect(deliveryState("m1")).toBe("replied");
  });

  it("starts delivered when the session wasn't busy, and the latest one is found", () => {
    noteDelivery("m1", "a", "b", false);
    noteDelivery("m2", "a", "b", false);
    noteDelivery("m3", "a", "c", false);
    expect(deliveryState("m2")).toBe("delivered");
    expect(latestDeliveryId("a", "b")).toBe("m2");
  });

  it("is named at the end of the tool's result", () => {
    const text = `Sent to b; its agent is answering it now. ${deliveryMarker("9f1c-22")}`;
    expect(deliveryIdIn(text)).toBe("9f1c-22");
    expect(deliveryIdIn("Sent to b.")).toBeUndefined();
  });
});
