import type { PickedElement } from "@/lib/pickedElement";

/** Where the browser panel's attachments go instead of the main input. */
export interface AttachTarget {
  element: (el: PickedElement) => void;
  files: (files: File[]) => void;
}

let current: AttachTarget | null = null;

/** While the selection reply box is open, an element picked in the browser or its annotated
 *  screenshot lands in that box, not in the main input. Returns the unregister function. */
export function setReplyAttachTarget(target: AttachTarget): () => void {
  current = target;
  return () => {
    if (current === target) current = null;
  };
}

export const replyAttachTarget = (): AttachTarget | null => current;
