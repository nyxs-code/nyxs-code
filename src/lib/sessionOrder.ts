/** The sessions in the order Recents shows them, kept here so Ctrl+Tab walks the same list the
 *  user sees. The sidebar fills it while it's open and the last order stays when it closes. */
let recentsOrder: string[] = [];

export function setSessionOrder(ids: string[]): void {
  recentsOrder = ids;
}

/** The session before or after `activeId` in Recents (wrapping around), or in `fallback` when
 *  the sidebar was never opened. Null when there is nowhere to go. */
export function adjacentSession(activeId: string | null, step: 1 | -1, fallback: string[]): string | null {
  const ids = recentsOrder.length ? recentsOrder : fallback;
  if (!ids.length) return null;
  const i = activeId ? ids.indexOf(activeId) : -1;
  if (i < 0) return step === 1 ? ids[0] : ids[ids.length - 1];
  const next = ids[(i + step + ids.length) % ids.length];
  return next === activeId ? null : next;
}
