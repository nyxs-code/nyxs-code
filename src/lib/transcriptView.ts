import { useSyncExternalStore } from "react";
import { accountKey } from "@/lib/accountScope";

/** How much of each turn's work the chat shows, like Claude Code Desktop's Ctrl+O:
 *  normal folds the steps into one line, thinking also shows the model's reasoning, and
 *  verbose opens every step. */
export type TranscriptView = "normal" | "thinking" | "verbose";

const ORDER: TranscriptView[] = ["normal", "thinking", "verbose"];
const KEY = "nyxs.transcriptView.v1";

const read = (): TranscriptView => {
  try {
    const v = localStorage.getItem(accountKey(KEY));
    return ORDER.includes(v as TranscriptView) ? (v as TranscriptView) : "normal";
  } catch {
    return "normal";
  }
};

let current: TranscriptView | null = null;
/** When the last Ctrl+O happened, so the chat can say which view it switched to. */
let changedAt = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getTranscriptView(): TranscriptView {
  current ??= read();
  return current;
}

/** Sets the view; from Settings it changes quietly, from Ctrl+O the chat names it briefly. */
export function setTranscriptView(view: TranscriptView, announce = false): void {
  current = view;
  if (announce) changedAt = Date.now();
  try {
    localStorage.setItem(accountKey(KEY), view);
  } catch {
    // Not kept across restarts; the view still changes.
  }
  emit();
}

export function cycleTranscriptView(): TranscriptView {
  const next = ORDER[(ORDER.indexOf(getTranscriptView()) + 1) % ORDER.length];
  setTranscriptView(next, true);
  return next;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTranscriptView(): TranscriptView {
  return useSyncExternalStore(subscribe, getTranscriptView, getTranscriptView);
}

/** The moment of the last switch (0 before any), for the brief notice that names the view. */
export function useTranscriptViewChangedAt(): number {
  return useSyncExternalStore(subscribe, () => changedAt, () => changedAt);
}
