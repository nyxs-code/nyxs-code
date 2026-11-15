import type { Clip } from "@/lib/video/timelineSchema";

/** Drag data type for a media-bin asset. Payload: JSON `{ "assetId": string }`. */
export const VIDEO_ASSET_MIME = "application/x-nyxs-video-asset";

/** Drag data type for a ready-made clip (text preset, shape…). Payload: JSON of a `Clip`; its
 *  `id` and `from` are replaced where it is dropped. */
export const VIDEO_CLIP_MIME = "application/x-nyxs-video-clip";

/** Call from a media-bin item's `onDragStart`. */
export function setAssetDragData(dt: DataTransfer, assetId: string): void {
  dt.setData(VIDEO_ASSET_MIME, JSON.stringify({ assetId }));
  dt.effectAllowed = "copy";
}

export function setClipDragData(dt: DataTransfer, clip: Clip): void {
  dt.setData(VIDEO_CLIP_MIME, JSON.stringify(clip));
  dt.effectAllowed = "copy";
}

export function hasTimelineDragData(dt: DataTransfer): boolean {
  return dt.types.includes(VIDEO_ASSET_MIME) || dt.types.includes(VIDEO_CLIP_MIME);
}
