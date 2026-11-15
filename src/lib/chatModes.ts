import type { PermissionMode } from "@/components/ui/claude-style-chat-input";

// The permission mode each chat runs in, for code outside React that must compare two chats
// (SendToSession). The app registers its resolver (useChatModeAndModel's chatModeOf).

let resolver: ((chatId: string) => PermissionMode | undefined) | null = null;

export function setChatModeResolver(fn: ((chatId: string) => PermissionMode | undefined) | null): void {
  resolver = fn;
}

/** The chat's mode, or undefined when the app hasn't said (then nothing is compared). */
export function chatModeOf(chatId: string): PermissionMode | undefined {
  return resolver?.(chatId);
}
