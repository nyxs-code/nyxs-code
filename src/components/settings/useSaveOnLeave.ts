import { useEffect, useRef, useState, type ChangeEvent } from "react";

/** Runs `save` when the settings page goes away (Settings closed, another page opened): a field
 *  doesn't lose focus then, so what was typed in it would be lost. The latest `save` runs, and
 *  it says itself whether there is anything to save. */
export function useSaveOnLeave(save: () => void): void {
  const latest = useRef(save);
  useEffect(() => {
    latest.current = save;
  });
  useEffect(() => () => latest.current(), []);
}

/** A Settings text field showing `value` that saves what was typed, trimmed, when it loses focus
 *  or the page goes away, and only when that differs from `value`: passing through a field
 *  writes nothing, not even the default it shows. Spread the result on the input. */
export function useSavedField(value: string, save: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  // Follow a new saved value (a reload, another layer) without an effect.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  const commit = () => {
    const next = draft.trim();
    if (next !== value.trim()) save(next);
  };
  useSaveOnLeave(commit);
  return {
    value: draft,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
  };
}
