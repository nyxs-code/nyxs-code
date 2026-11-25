// Adds files to the message being written from anywhere in the app (an annotated image from the
// image viewer), without passing a callback down through every message. App sets the target.

let attach: ((files: File[]) => void) | null = null;

export function setComposerAttach(fn: ((files: File[]) => void) | null): void {
  attach = fn;
}

/** Puts the files in the message box (or the reply box, when one is open); false when there's none. */
export function attachToComposer(files: File[]): boolean {
  if (!attach) return false;
  attach(files);
  return true;
}

export function canAttachToComposer(): boolean {
  return !!attach;
}
