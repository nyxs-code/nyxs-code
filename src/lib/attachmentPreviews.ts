/** Thumbnails of attached images are object URLs (`blob:`), which hold the image in memory until
 *  revoked. A message keeps its own while it can still be shown (in the chat box, the queue, or
 *  given back to the box after a failed send); once it is gone for good its thumbnails are
 *  released here, and one released by mistake is drawn again by livePreview. */
const released = new Set<string>();

interface Previewed {
  file: File;
  preview?: string | null;
}

/** Frees the thumbnails of attachments no one will show again. */
export function releasePreviews(files: readonly Previewed[] | undefined): void {
  for (const f of files ?? []) {
    if (!f.preview?.startsWith("blob:") || released.has(f.preview)) continue;
    released.add(f.preview);
    URL.revokeObjectURL(f.preview);
  }
}

/** The attachment as it can be shown now: with a new thumbnail if its old one was released. */
export function livePreview<F extends Previewed>(f: F): F {
  return f.preview && released.has(f.preview) ? { ...f, preview: URL.createObjectURL(f.file) } : f;
}
