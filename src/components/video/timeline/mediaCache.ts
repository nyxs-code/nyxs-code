import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "@/lib/ipc";

export interface MediaProject {
  workspace: string;
  slug: string;
}

// Results are cached for the whole session: the backend caches on disk too, but this avoids an
// IPC round trip every time a clip scrolls back into view.
const thumbs = new Map<string, Promise<string[]>>();
const waves = new Map<string, Promise<number[]>>();

function thumbnails(p: MediaProject, assetId: string, count: number): Promise<string[]> {
  const key = `${p.workspace}\n${p.slug}\n${assetId}\n${count}`;
  let hit = thumbs.get(key);
  if (!hit) {
    hit = invoke<string[]>("video_thumbnails", { workspace: p.workspace, slug: p.slug, assetId, count })
      .then((paths) => paths.map((path) => convertFileSrc(path)))
      .catch(() => {
        thumbs.delete(key);
        return [];
      });
    thumbs.set(key, hit);
  }
  return hit;
}

function waveform(p: MediaProject, assetId: string, buckets: number): Promise<number[]> {
  const key = `${p.workspace}\n${p.slug}\n${assetId}\n${buckets}`;
  let hit = waves.get(key);
  if (!hit) {
    hit = invoke<number[]>("video_waveform", { workspace: p.workspace, slug: p.slug, assetId, buckets }).catch(() => {
      waves.delete(key);
      return [];
    });
    waves.set(key, hit);
  }
  return hit;
}

/** Thumbnail URLs spread evenly over the asset, or [] while loading / on failure. */
export function useThumbnails(project: MediaProject | null, assetId: string | null, count: number): string[] {
  const [result, setResult] = useState<{ key: string; urls: string[] } | null>(null);
  const key = project && assetId ? `${project.workspace}\n${project.slug}\n${assetId}\n${count}` : "";
  useEffect(() => {
    if (!project || !assetId) return;
    let live = true;
    void thumbnails(project, assetId, count).then((urls) => {
      if (live) setResult({ key, urls });
    });
    return () => {
      live = false;
    };
  }, [project, assetId, count, key]);
  return result?.key === key ? result.urls : [];
}

/** Peaks (0..1) over the whole asset, or [] while loading / on failure. */
export function useWaveform(project: MediaProject | null, assetId: string | null, buckets: number): number[] {
  const [result, setResult] = useState<{ key: string; peaks: number[] } | null>(null);
  const key = project && assetId ? `${project.workspace}\n${project.slug}\n${assetId}\n${buckets}` : "";
  useEffect(() => {
    if (!project || !assetId) return;
    let live = true;
    void waveform(project, assetId, buckets).then((peaks) => {
      if (live) setResult({ key, peaks });
    });
    return () => {
      live = false;
    };
  }, [project, assetId, buckets, key]);
  return result?.key === key ? result.peaks : [];
}
