import { convertFileSrc } from "@tauri-apps/api/core";
import type { Asset, Timeline } from "@/lib/video/timelineSchema";
import { stageFile } from "@/lib/video/videoApi";

/** Adds imported assets to the document, replacing ones with the same id. */
export function withAssets(tl: Timeline, assets: Asset[]): Timeline {
  const ids = new Set(assets.map((a) => a.id));
  return { ...tl, assets: [...tl.assets.filter((a) => !ids.has(a.id)), ...assets] };
}

/** Files dropped from the OS reach the page without a path (the window's native drop is off for
 *  the chat), so their bytes are staged in the cache first. */
export async function pathsOfDroppedFiles(workspace: string, files: FileList | File[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of Array.from(files)) out.push(await stageFile(workspace, f));
  return out;
}

export function hasOsFiles(e: { dataTransfer: DataTransfer }) {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/** A project's still for an <img>. The poster re-renders in the background into the same path,
 *  after the list answered, so only the ready event's version can bust the WebView's image
 *  cache (not updatedAt). */
export function thumbnailUrl(path: string | null | undefined, version = 0): string | null {
  return path ? `${convertFileSrc(path)}?v=${version}` : null;
}
