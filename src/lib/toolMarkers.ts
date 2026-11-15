/** The end of a tool card that was cut off by a stop before it reported back (see parse.ts). */
export function stoppedToolMarker(id: string): string {
  return `⟦TOOLEND⟧${id}⟦SEP⟧stop⟦/TOOLEND⟧`;
}

/** `content` with every tool card still open (no ⟦TOOLEND⟧ of its own) closed as stopped, so a
 *  stopped reply doesn't show them as finished. */
export function closeOpenTools(content: string): string {
  const ended = new Set([...content.matchAll(/⟦TOOLEND⟧([^⟦]*?)⟦SEP⟧/g)].map((m) => m[1]));
  const open = [...content.matchAll(/⟦TOOL⟧([^⟦]*?)⟦SEP⟧/g)].map((m) => m[1]).filter((id) => !ended.has(id));
  return open.length ? content + [...new Set(open)].map(stoppedToolMarker).join("") : content;
}
