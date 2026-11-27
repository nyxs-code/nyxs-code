import type { ChatMessage } from "@/components/Message";

// A message for a cloud thread (typed in its chat, or sent by the coordinator) goes to the Nyxs
// cloud instead of starting a local turn. The projects hook sets the route; sending asks it first.

type Route = (chatId: string, message: ChatMessage, text: string) => Promise<boolean>;

let route: Route | null = null;

export function setCloudRoute(r: Route | null): void {
  route = r;
}

/** Sends `message` to the cloud thread `chatId` shows, and adds it there. False when `chatId`
 *  isn't a cloud thread: the caller runs its turn as usual. */
export function routeToCloud(chatId: string, message: ChatMessage, text: string): Promise<boolean> {
  return route ? route(chatId, message, text) : Promise.resolve(false);
}
