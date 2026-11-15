import type { ImageAttachment } from "@/lib/ai";

export interface InboxMessage {
  id: string;
  text: string;
  images?: ImageAttachment[];
}

export interface TurnInbox {
  take: () => InboxMessage[];
  consumed: (items: InboxMessage[]) => void;
  onArrive: (listener: () => void) => () => void;
  onHurry: (listener: () => void) => () => void;
}
