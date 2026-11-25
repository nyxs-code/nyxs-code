import { useSyncExternalStore } from "react";

/** Where a message sent to another session (SendToSession) is, like Claude's "Queued / Delivered /
 *  Read / Replied": waiting for that session's turn to end, in it, taken into its agent's turn, or
 *  answered with a message back. */
export type DeliveryState = "queued" | "delivered" | "read" | "replied";

interface Delivery {
  from?: string;
  to: string;
  state: DeliveryState;
}

const deliveries = new Map<string, Delivery>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** A message went to session `to` (its card's id is `id`), now or queued for its next turn. */
export function noteDelivery(id: string, from: string | undefined, to: string, queued: boolean): void {
  deliveries.set(id, { from, to, state: queued ? "queued" : "delivered" });
  changed();
}

/** The session's turn took these messages in. */
export function markRead(messageIds: string[]): void {
  let any = false;
  for (const id of messageIds) {
    const d = deliveries.get(id);
    if (d && (d.state === "queued" || d.state === "delivered")) {
      d.state = "read";
      any = true;
    }
  }
  if (any) changed();
}

/** Session `replier` sent a message back to `sender`: what `sender` had sent it is answered. */
export function markReplied(replier: string, sender: string): void {
  let any = false;
  for (const d of deliveries.values()) {
    if (d.from === sender && d.to === replier && d.state !== "replied") {
      d.state = "replied";
      any = true;
    }
  }
  if (any) changed();
}

/** The latest message `from` sent to `to`, right after sending it. */
export function latestDeliveryId(from: string | undefined, to: string): string | undefined {
  let last: string | undefined;
  for (const [id, d] of deliveries) if (d.from === from && d.to === to) last = id;
  return last;
}

export function deliveryState(id: string | undefined): DeliveryState | undefined {
  return id ? deliveries.get(id)?.state : undefined;
}

export function useDeliveryState(id: string | undefined): DeliveryState | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return deliveryState(id);
}

/** Ends the tool's result, so the chat's chip finds the message (and the agent can name it). */
export const deliveryMarker = (id: string) => `Message id: ${id}.`;

export function deliveryIdIn(text: string | undefined): string | undefined {
  return text ? /Message id: ([\w-]+)\./.exec(text)?.[1] : undefined;
}

export function resetDeliveriesForTests(): void {
  deliveries.clear();
  changed();
}
