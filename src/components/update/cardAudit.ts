/**
 * What doesn't fit in a drawn update card: a text cut short (`data-fit`: its box is smaller
 * than what it holds, so an ellipsis or a clamp is hiding part of it) and a piece of a demo
 * that sticks out of its frame (`data-box`: outside the nearest `data-clip`, or the stage).
 * Used by the E2E audit and the card harness (`dev/update-card.html`).
 */
export function auditCard(card: HTMLElement): string[] {
  const problems: string[] = [];
  for (const el of card.querySelectorAll<HTMLElement>("[data-fit]")) {
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      problems.push(`"${el.dataset.fit}" is cut (${el.scrollWidth}×${el.scrollHeight} in ${el.clientWidth}×${el.clientHeight}): ${el.textContent?.trim()}`);
    }
  }
  const stage = card.querySelector<HTMLElement>("[data-card-stage]");
  if (!stage) return problems;
  for (const el of stage.querySelectorAll<HTMLElement>("[data-box]")) {
    const frame = el.parentElement?.closest<HTMLElement>("[data-clip]") ?? stage;
    const r = el.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    if (r.left < f.left - 1 || r.right > f.right + 1 || r.top < f.top - 1 || r.bottom > f.bottom + 1) {
      problems.push(`"${el.dataset.box}" sticks out of its frame by ${Math.round(Math.max(f.left - r.left, r.right - f.right, f.top - r.top, r.bottom - f.bottom))}px`);
    }
  }
  return problems;
}
