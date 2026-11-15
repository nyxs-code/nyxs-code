import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Loader2, Plus, Search, Square, Type, Upload } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { newId, type Asset, type Clip, type Composition } from "@/lib/video/timelineSchema";
import { getPlayhead, timelineActions, useTimelineStore } from "@/lib/video/timelineStore";
import { importMedia, thumbnails } from "@/lib/video/videoApi";
import { Button } from "@/components/ui/button";
import { setAssetDragData, setClipDragData } from "./timeline/dnd";
import { ClipIcon } from "./ClipIcon";
import { hasOsFiles, pathsOfDroppedFiles, withAssets } from "./media";
import { formatDuration } from "./timecode";

type Filter = "all" | Asset["kind"];

const MEDIA_EXTENSIONS = ["mp4", "mov", "webm", "mkv", "avi", "m4v", "png", "jpg", "jpeg", "gif", "webp", "svg", "mp3", "wav", "m4a", "aac", "ogg", "flac", "ttf", "otf", "woff", "woff2"];

/** The left column: the project's media, to import and drag onto the timeline. */
export function MediaBin({ workspace, slug }: { workspace: string; slug: string }) {
  const t = useTranslations().videoPanel;
  const assets = useTimelineStore((s) => s.timeline?.assets ?? EMPTY);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const runImport = async (getPaths: () => Promise<string[]>) => {
    setError(null);
    try {
      const paths = await getPaths();
      if (!paths.length) return;
      setImporting(paths.length);
      const added = await importMedia(workspace, slug, paths);
      if (added.length) timelineActions.apply((tl) => withAssets(tl, added));
    } catch (e) {
      setError(t.importFailed.replace("{error}", e instanceof Error ? e.message : String(e)));
    } finally {
      setImporting(0);
    }
  };

  const pick = () =>
    runImport(async () => {
      const picked = await openDialog({ multiple: true, filters: [{ name: t.media, extensions: MEDIA_EXTENSIONS }] });
      if (!picked) return [];
      return Array.isArray(picked) ? picked : [picked];
    });

  const counts = { all: assets.length, video: 0, image: 0, audio: 0, font: 0 } as Record<Filter, number>;
  for (const a of assets) counts[a.kind]++;
  const q = query.trim().toLowerCase();
  const shown = assets.filter((a) => (filter === "all" || a.kind === filter) && (!q || a.name.toLowerCase().includes(q)));
  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: t.filterAll },
    { id: "video", label: t.filterVideo },
    { id: "image", label: t.filterImage },
    { id: "audio", label: t.filterAudio },
    { id: "font", label: t.filterFont },
  ];

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (!hasOsFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        if (!hasOsFiles(e)) return;
        e.preventDefault();
        // The chat composer listens for drops on the window; this one is for the video.
        e.stopPropagation();
        const files = Array.from(e.dataTransfer.files);
        void runImport(() => pathsOfDroppedFiles(workspace, files));
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 pl-3 pr-1.5">
        <span className="flex-1 truncate text-[12px] font-medium text-text-200">{t.media}</span>
        <Button variant="ghost" className="h-6 gap-1 px-1.5 text-[12px]" onClick={() => void pick()} disabled={importing > 0}>
          {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {t.import}
        </Button>
      </div>
      <div className="shrink-0 space-y-1.5 px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={t.filterPlaceholder}
            aria-label={t.filterPlaceholder}
            className="h-6 w-full rounded-[6px] border border-bg-300 bg-bg-0 pl-7 pr-2 text-[12px] text-text-100 outline-none placeholder:text-text-400 focus:border-accent/70"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {filters
            .filter((f) => f.id === "all" || counts[f.id] > 0 || filter === f.id)
            .map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={cn(
                  "h-5 rounded-[6px] px-1.5 text-[11.5px] transition-colors",
                  filter === f.id ? "bg-bg-200 text-text-100" : "text-text-300 hover:bg-bg-200/60 hover:text-text-100",
                )}
              >
                {f.label}
                <span className="ml-1 text-text-400 tabular-nums">{counts[f.id]}</span>
              </button>
            ))}
        </div>
      </div>
      {error && <p className="mx-2 mb-2 rounded-[6px] bg-red-500/10 px-2 py-1.5 text-[11.5px] leading-snug text-red-600 dark:text-red-400">{error}</p>}
      {importing > 0 && <p className="mx-2 mb-2 text-[11.5px] text-text-400">{t.importing.replace("{n}", String(importing))}</p>}
      <Elements />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 custom-scrollbar">
        {assets.length === 0 ? (
          <button
            type="button"
            onClick={() => void pick()}
            className="flex w-full flex-col items-center gap-1.5 rounded-[8px] border border-dashed border-bg-300 px-3 py-6 text-center hover:border-text-400"
          >
            <Upload className="h-4 w-4 text-text-400" />
            <span className="text-[12.5px] text-text-200">{t.emptyMedia}</span>
            <span className="text-[11.5px] leading-snug text-text-400">{t.emptyMediaHint}</span>
          </button>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1.5">
            {shown.map((a) => (
              <AssetTile key={a.id} asset={a} workspace={workspace} slug={slug} addLabel={t.addToTimeline} />
            ))}
          </div>
        )}
      </div>
      {dropping && (
        <div className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-[8px] border-2 border-dashed border-accent/60 bg-accent/5">
          <span className="text-[12.5px] text-text-200">{t.dropHere}</span>
        </div>
      )}
    </div>
  );
}

const EMPTY: Asset[] = [];

/** Ready-made clips: a title and a shape, sized for the composition. */
function elementClip(kind: "text" | "shape", comp: Composition, title: string): Clip {
  const base = { id: newId("clip"), from: 0, durationInFrames: Math.round(comp.fps * 3) };
  if (kind === "text") {
    return {
      ...base,
      type: "text",
      name: title,
      text: title,
      style: { fontFamily: "Inter", fontSize: Math.round(comp.height / 12), fontWeight: 700, color: "#ffffff", align: "center" },
      animation: { in: { kind: "slide-up", durationInFrames: Math.round(comp.fps / 2) } },
    };
  }
  const size = Math.round(Math.min(comp.width, comp.height) / 3);
  return { ...base, type: "shape", shape: "rect", fill: "#3b82f6", width: size, height: size, radius: Math.round(size / 12) };
}

function Elements() {
  const t = useTranslations().videoPanel;
  const comp = useTimelineStore((s) => s.timeline?.compositions.find((c) => c.id === s.compositionId) ?? null);
  if (!comp) return null;
  const items = [
    { kind: "text" as const, label: t.text, icon: <Type className="h-3.5 w-3.5" /> },
    { kind: "shape" as const, label: t.shapeRect, icon: <Square className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="shrink-0 px-2 pb-2">
      <div className="mb-1 text-[11px] text-text-400">{t.elements}</div>
      <div className="flex gap-1.5">
        {items.map((it) => (
          <button
            key={it.kind}
            type="button"
            draggable
            onDragStart={(e) => setClipDragData(e.dataTransfer, elementClip(it.kind, comp, t.defaultTitle))}
            onClick={() => timelineActions.placeClip({ ...elementClip(it.kind, comp, t.defaultTitle), from: getPlayhead() }, null)}
            data-tooltip={t.addToTimeline}
            className="flex h-7 min-w-0 flex-1 cursor-grab items-center justify-center gap-1.5 rounded-[6px] border border-bg-300 bg-bg-0 text-[12px] text-text-200 hover:border-text-400 hover:text-text-100 active:cursor-grabbing"
          >
            {it.icon}
            <span className="truncate">{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Thumbnails per asset for this run of the app; the backend caches them on disk too. */
const thumbCache = new Map<string, string | null>();

function useThumbnail(workspace: string, slug: string, asset: Asset): string | null {
  const key = `${workspace}|${slug}|${asset.id}`;
  const [fetched, setFetched] = useState<{ key: string; url: string | null } | null>(null);
  const wanted = asset.kind === "video" || asset.kind === "image";
  useEffect(() => {
    if (!wanted || thumbCache.has(key)) return;
    let alive = true;
    thumbnails(workspace, slug, asset.id, 1)
      .then((paths) => {
        const url = paths[0] ? convertFileSrc(paths[0]) : null;
        thumbCache.set(key, url);
        if (alive) setFetched({ key, url });
      })
      .catch(() => thumbCache.set(key, null));
    return () => { alive = false; };
  }, [key, wanted, workspace, slug, asset.id]);
  if (fetched?.key === key) return fetched.url;
  return thumbCache.get(key) ?? null;
}

function AssetTile({ asset, workspace, slug, addLabel }: { asset: Asset; workspace: string; slug: string; addLabel: string }) {
  const thumb = useThumbnail(workspace, slug, asset);
  const fps = asset.fps ?? 30;
  const placeable = asset.kind !== "font";

  const addAtPlayhead = () => {
    timelineActions.placeAsset(asset.id, null, getPlayhead());
  };

  return (
    <div
      draggable={placeable}
      onDragStart={(e) => {
        setAssetDragData(e.dataTransfer, asset.id);
      }}
      onDoubleClick={placeable ? addAtPlayhead : undefined}
      className={cn("group relative overflow-hidden rounded-[6px] border border-bg-300 bg-bg-0", placeable && "cursor-grab active:cursor-grabbing")}
    >
      <div className="relative aspect-video bg-bg-200/60">
        {thumb ? (
          <img src={thumb} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
        ) : asset.kind === "font" ? (
          <span className="absolute inset-0 flex items-center justify-center text-[20px] text-text-200" style={{ fontFamily: asset.name }}>Aa</span>
        ) : (
          <span className="absolute inset-0 flex items-center justify-center">
            <ClipIcon type={asset.kind} className="h-5 w-5 text-text-400" />
          </span>
        )}
        {asset.durationInFrames ? (
          <span className="absolute bottom-1 right-1 rounded-[4px] bg-black/60 px-1 text-[10.5px] font-medium tabular-nums text-white">
            {formatDuration(asset.durationInFrames, fps)}
          </span>
        ) : null}
        {placeable && (
          <button
            type="button"
            onClick={addAtPlayhead}
            aria-label={addLabel}
            data-tooltip={addLabel}
            className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-[4px] bg-black/60 text-white hover:bg-black/80 group-hover:flex"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1">
        <ClipIcon type={asset.kind} className="h-3 w-3 shrink-0 text-text-400" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-200">{asset.name}</span>
      </div>
    </div>
  );
}
