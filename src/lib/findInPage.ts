const MATCH_NAME = "find-match";
const CURRENT_NAME = "find-current";
const MAX_RANGES = 2000;

export function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

export function collectRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!node.nodeValue || !parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, [aria-hidden='true'], [data-find-ignore]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node && ranges.length < MAX_RANGES) {
    const haystack = (node.nodeValue ?? "").toLowerCase();
    let from = haystack.indexOf(needle);
    while (from !== -1 && ranges.length < MAX_RANGES) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      ranges.push(range);
      from = haystack.indexOf(needle, from + needle.length);
    }
    node = walker.nextNode();
  }
  return ranges;
}

export function paintHighlights(ranges: Range[], currentIndex: number): void {
  if (!highlightsSupported()) return;
  CSS.highlights.set(MATCH_NAME, new Highlight(...ranges));
  const current = ranges[currentIndex];
  if (current) CSS.highlights.set(CURRENT_NAME, new Highlight(current));
  else CSS.highlights.delete(CURRENT_NAME);
}

export function clearHighlights(): void {
  if (!highlightsSupported()) return;
  CSS.highlights.delete(MATCH_NAME);
  CSS.highlights.delete(CURRENT_NAME);
}

export function revealRange(range: Range | undefined): void {
  const el = range?.startContainer.parentElement;
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}

export function rangesStale(ranges: Range[]): boolean {
  return ranges.some((r) => !r.startContainer.isConnected);
}

export function wrapIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index % total) + total) % total;
}
