/** Live status lines from a running tool to its chat chip ("Installing the video runtime… 40%").
 *  A tool calls `reportToolProgress` with its `toolCallId`; the turn stream forwards the latest
 *  line into the chip's `ToolDetail.progress`. */

type Listener = (toolCallId: string, text: string) => void;

const listeners = new Set<Listener>();

export function reportToolProgress(toolCallId: string | undefined, text: string): void {
  if (!toolCallId) return;
  for (const l of listeners) l(toolCallId, text);
}

export function subscribeToolProgress(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
