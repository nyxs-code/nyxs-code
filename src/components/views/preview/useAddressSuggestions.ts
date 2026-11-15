import { useEffect, useMemo, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { browserSearch } from "@/lib/featureSettings";
import { parseSuggestions, searchEngineName, suggestionsUrl } from "@/lib/searchEngines";
import { buildAddressSuggestions, wantsWebSuggestions, type AddressSuggestion } from "./addressSuggestions";

/** Waits this long after the last key before asking the engine, as browsers roughly do. */
const DEBOUNCE_MS = 120;

/** Answers already fetched in this run, so going back over the same letters asks nothing. */
const cache = new Map<string, string[]>();

/** The list under the address bar while it has the focus and the text was edited: what it
 *  offers and which row the arrow keys are on (-1: none, Enter opens what was typed). */
export function useAddressSuggestions({ input, focused }: { input: string; focused: boolean }) {
  // Shown once the user types; the page's own address doesn't open it on focus.
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [lastFocused, setLastFocused] = useState(focused);
  const [web, setWeb] = useState<{ query: string; words: string[] }>({ query: "", words: [] });
  // Cleared when the address loses the focus, not when it gets it: the focus and the first key
  // can land in the same render, and clearing then would swallow that key.
  if (focused !== lastFocused) {
    setLastFocused(focused);
    if (!focused) {
      setTyped(false);
      setDismissed(false);
      setActive(-1);
    }
  }

  const query = input.trim();
  const url = focused && typed && wantsWebSuggestions(query) ? suggestionsUrl(query, browserSearch()) : undefined;
  useEffect(() => {
    if (!url || cache.has(url)) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      tauriFetch(url, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: unknown) => {
          const words = parseSuggestions(body);
          cache.set(url, words);
          if (!ctl.signal.aborted) setWeb({ query, words });
        })
        // Offline or blocked: the list keeps just what was typed.
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [url, query]);

  const items: AddressSuggestion[] = useMemo(() => {
    if (!focused || !typed) return [];
    // While the next answer is on its way, the words of the last one that still fit what is
    // typed stay, so the list doesn't flicker on every key.
    const q = query.toLowerCase();
    const words = !url ? [] : cache.get(url) ?? (web.query === query ? web.words : web.words.filter((w) => w.toLowerCase().startsWith(q)));
    return buildAddressSuggestions(query, words, searchEngineName(browserSearch()));
  }, [focused, typed, query, url, web]);
  const open = items.length > 0 && !dismissed;

  return {
    items: open ? items : [],
    open,
    active: open ? Math.min(active, items.length - 1) : -1,
    /** The text changed: show the list again, with no row picked. */
    onType: () => { setTyped(true); setDismissed(false); setActive(-1); },
    /** ↑/↓ move through the rows; past either end, back to what was typed. */
    move: (delta: number) => {
      if (!open) return;
      setActive((i) => {
        const n = items.length;
        const next = i + delta;
        return next < -1 ? n - 1 : next >= n ? -1 : next;
      });
    },
    setActive,
    close: () => { setDismissed(true); setActive(-1); },
  };
}
