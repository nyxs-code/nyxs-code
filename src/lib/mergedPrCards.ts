import { useSyncExternalStore } from "react";
import { accountKey } from "@/lib/accountScope";

/** The purple "PR #n merged into main" cards above a chat's Git bar: the PRs merged while the
 *  chat was open (its own branch's, or ones the agent merged), until dismissed. Kept across
 *  restarts so a dismissed card never comes back. */
const KEY = "nyxs.mergedPrCards.v1";
/** A card left open goes away on its own after a day; a merge that old isn't news. */
const CARD_TTL_MS = 24 * 60 * 60_000;
/** Dismissed PRs are remembered for a while, then forgotten (they are past the card TTL by then). */
const DISMISSED_TTL_MS = 30 * 24 * 60 * 60_000;

export interface MergedPrCard {
  url: string;
  number: number;
  base: string;
  mergedAt: number;
}

interface Store {
  /** By scope: the chat's session id, or its folder when it has none. Newest first. */
  cards: Record<string, MergedPrCard[]>;
  /** PR URL → when it was dismissed. */
  dismissed: Record<string, number>;
}

const EMPTY: MergedPrCard[] = [];
const listeners = new Set<() => void>();
let cache: Store | null = null;

function prune(s: Store, now: number): Store {
  const cards: Store["cards"] = {};
  for (const [scope, list] of Object.entries(s.cards)) {
    const live = list.filter((c) => now - c.mergedAt < CARD_TTL_MS && !s.dismissed[c.url]);
    if (live.length) cards[scope] = live;
  }
  const dismissed = Object.fromEntries(Object.entries(s.dismissed).filter(([, at]) => now - at < DISMISSED_TTL_MS));
  return { cards, dismissed };
}

function read(): Store {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(KEY)) || "{}") as Partial<Store>;
    cache = prune({ cards: raw.cards ?? {}, dismissed: raw.dismissed ?? {} }, Date.now());
  } catch {
    cache = { cards: {}, dismissed: {} };
  }
  return cache;
}

function write(next: Store): void {
  cache = next;
  try {
    localStorage.setItem(accountKey(KEY), JSON.stringify(next));
  } catch {
    // Still shown for this run.
  }
  listeners.forEach((l) => l());
}

/** Shows a card for a merged PR, unless it was dismissed or is old news. One already shown is
 *  filled in instead (a card put up from gh's output gets its base branch once GitHub answers). */
export function addMergedPrCard(scope: string, card: MergedPrCard): void {
  const s = read();
  const list = s.cards[scope] ?? EMPTY;
  if (s.dismissed[card.url] || Date.now() - card.mergedAt >= CARD_TTL_MS) return;
  const shown = list.find((c) => c.url === card.url);
  if (shown && (shown.base === card.base || !card.base)) return;
  const filled = shown ? { ...shown, base: card.base } : card;
  const next = [filled, ...list.filter((c) => c.url !== card.url)].sort((a, b) => b.mergedAt - a.mergedAt);
  write({ ...s, cards: { ...s.cards, [scope]: next } });
}

export function dismissMergedPrCards(scope: string, urls: string[]): void {
  const s = read();
  const now = Date.now();
  const dismissed = { ...s.dismissed };
  for (const url of urls) dismissed[url] = now;
  const left = (s.cards[scope] ?? EMPTY).filter((c) => !urls.includes(c.url));
  const cards = { ...s.cards };
  if (left.length) cards[scope] = left;
  else delete cards[scope];
  write({ cards, dismissed });
}

export function useMergedPrCards(scope: string | null): MergedPrCard[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (scope ? read().cards[scope] ?? EMPTY : EMPTY),
  );
}

/** For tests: forget the in-memory copy so the next read goes to localStorage. */
export function resetMergedPrCardsForTests(): void {
  cache = null;
}
