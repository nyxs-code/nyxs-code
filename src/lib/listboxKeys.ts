/** Where a key moves the selection of a single-select listbox (WAI-ARIA listbox pattern): ↑/↓
 *  one step without wrapping, Home/End to the ends, and a printable character to the next item
 *  whose label starts with it (wrapping, from the one after the current). Null when the key
 *  doesn't move it, so the caller leaves the event alone. */
export function listboxMove<T extends string>(
  ids: readonly T[],
  current: T | null,
  key: string,
  labelOf: (id: T) => string,
): T | null {
  if (!ids.length) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  switch (key) {
    case "ArrowDown":
      return ids[Math.min(ids.length - 1, at + 1)];
    case "ArrowUp":
      return at <= 0 ? ids[0] : ids[at - 1];
    case "Home":
      return ids[0];
    case "End":
      return ids[ids.length - 1];
  }
  if ([...key].length !== 1 || !key.trim()) return null;
  const letter = fold(key);
  for (let step = 1; step <= ids.length; step++) {
    const id = ids[(at + step + ids.length) % ids.length];
    if (fold(labelOf(id)).startsWith(letter)) return id;
  }
  return null;
}

/** Case and accents don't matter when typing to jump ("é" finds "Ecosia"). */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
