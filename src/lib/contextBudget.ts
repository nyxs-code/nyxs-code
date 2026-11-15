export interface CompactionBudget {
  window: number;
  trigger: number;
  keep: number;
}

export function compactionBudget(window: number, maxOutputTokens: number): CompactionBudget {
  const reserve = Math.min(Math.max(maxOutputTokens, 16_000), Math.round(window * 0.2));
  const trigger = Math.floor(Math.min(window * 0.8, window - reserve));
  const keep = Math.round(Math.min(Math.max(window * 0.15, 8_000), 40_000));
  return { window, trigger, keep };
}

export function chooseCompactionCut(turnTokens: number[], keep: number): number {
  if (turnTokens.length < 2) return 0;
  let cut = turnTokens.length - 1;
  let kept = turnTokens[cut];
  for (let i = turnTokens.length - 2; i >= 0; i--) {
    if (kept + turnTokens[i] > keep) break;
    kept += turnTokens[i];
    cut = i;
  }
  return cut;
}
