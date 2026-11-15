/** Asks before a view of the side panel closes: gets the close and runs it, later or never, and
 *  the cancel, run when the user keeps the view open. */
export type ViewCloseGuard = (close: () => void, cancel?: () => void) => void;

const guards = new Map<string, ViewCloseGuard>();

/** A view with something to lose on close (Files, with an unsaved file) sets its guard while
 *  mounted, and clears it with `null`. */
export function setViewCloseGuard(view: string, guard: ViewCloseGuard | null): void {
  if (guard) guards.set(view, guard);
  else guards.delete(view);
}

/** Closes the view, through its guard when it has one. */
export function closeViewGuarded(view: string, close: () => void, cancel?: () => void): void {
  const guard = guards.get(view);
  if (guard) guard(close, cancel);
  else close();
}

/** Whether the view may go (another folder opens, its own closes): true at once without a guard,
 *  else once the user decided; false when they kept it. */
export function leaveViewGuarded(view: string): Promise<boolean> {
  return new Promise((resolve) => closeViewGuarded(view, () => resolve(true), () => resolve(false)));
}

/** Toggles a view (the views menu, its shortcut): closing it goes through its guard, opening it
 *  doesn't. */
export function toggleViewGuarded(view: string, isOpen: boolean, toggle: () => void): void {
  if (isOpen) closeViewGuarded(view, toggle);
  else toggle();
}
