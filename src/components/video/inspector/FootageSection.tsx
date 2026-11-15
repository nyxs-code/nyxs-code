import { useState, type ReactNode } from "react";
import { AudioLines, Camera, Loader2, Scissors, Snowflake, Unlink } from "lucide-react";
import type { Translations } from "@/lib/i18n";
import { cutRanges, silencesInClip, type FrameRange } from "@/lib/video/cutRanges";
import { clipEnd, type Clip, type Composition, type Timeline } from "@/lib/video/timelineSchema";
import { getPlayhead, timelineActions } from "@/lib/video/timelineStore";
import * as videoApi from "@/lib/video/videoApi";
import { Button } from "@/components/ui/button";
import { withAssets } from "../media";
import { startStill } from "../render/renderJobs";
import { detachAudio, insertHold } from "./footageOps";
import { NumberInput, Row, Section } from "./fields";

type T = Translations["videoPanel"];
type Media = Extract<Clip, { type: "video" | "audio" }>;

/** The exact frame of the clip's asset (not the composition, whose other tracks would be baked
 *  into the hold); the composition's still at that frame if that fails. */
async function frameImage(workspace: string, slug: string, comp: Composition, clip: Media, playhead: number, name: string): Promise<string> {
  const rate = clip.type === "video" ? clip.playbackRate ?? 1 : 1;
  const secs = (clip.trimStart + (playhead - clip.from) * rate) / comp.fps;
  try {
    return await videoApi.assetFrame(workspace, slug, clip.assetId, secs);
  } catch {
    // An asset the backend can't take a frame from: the composition's still instead.
  }
  return videoApi.still(workspace, slug, comp.id, playhead, name);
}

/** Editing helpers for footage: detach audio, freeze frame, extract a still, remove silences. */
export function FootageSection({ clip, comp, timeline, playhead, workspace, slug, t }: { clip: Media; comp: Composition; timeline: Timeline; playhead: number; workspace: string; slug: string; t: T }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [holdSecs, setHoldSecs] = useState(2);
  const [thresholdDb, setThresholdDb] = useState(-40);
  const [minSilenceMs, setMinSilenceMs] = useState(600);
  const [paddingMs, setPaddingMs] = useState(150);
  const underPlayhead = playhead >= clip.from && playhead < clipEnd(clip);
  const base = (clip.name ?? clip.id).replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-");

  const run = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key);
    setNote(null);
    try {
      const text = await fn();
      if (text) setNote({ text });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const detach = () =>
    run("detach", async () => {
      timelineActions.apply((tl, c) => detachAudio(tl, c, clip.id)?.timeline ?? tl);
      return null;
    });

  const freeze = () =>
    run("freeze", async () => {
      const frame = getPlayhead();
      const path = await frameImage(workspace, slug, comp, clip, frame, `${base}-hold-${frame}`);
      const [image] = await videoApi.importMedia(workspace, slug, [path]);
      if (!image) return null;
      timelineActions.apply((tl, c) => {
        const r = insertHold(withAssets(tl, [image]), c, clip.id, frame, image, holdSecs * comp.fps);
        return r?.timeline ?? tl;
      });
      return null;
    });

  const extract = () =>
    run("still", async () => {
      const frame = getPlayhead();
      await startStill(workspace, slug, `${comp.name} · ${t.formats.png}`, comp.id, frame, `${base}-${frame}`);
      return t.stillSaved;
    });

  const removeSilences = () =>
    run("silences", async () => {
      const silences = (await videoApi.detectSilences(workspace, slug, clip.assetId, thresholdDb, minSilenceMs)) as FrameRange[];
      const asset = timeline.assets.find((a) => a.id === clip.assetId);
      const ranges = silencesInClip(clip, comp.fps, asset?.fps || comp.fps, silences, Math.round((paddingMs * comp.fps) / 1000));
      if (!ranges.length) return t.noSilences;
      let removed = 0;
      timelineActions.apply((tl, c) => {
        const r = cutRanges(tl, c, ranges);
        removed = r.removedFrames;
        return r.timeline;
      });
      return t.silencesRemoved.replace("{n}", String(ranges.length)).replace("{secs}", (removed / comp.fps).toFixed(1));
    });

  const action = (key: string, icon: ReactNode, label: string, onClick: () => void, disabled = false, hint?: string) => (
    <Button variant="secondary" className="h-7 w-full justify-start text-[12px]" disabled={!!busy || disabled} onClick={onClick} data-tooltip={hint}>
      {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      <span className="truncate">{label}</span>
    </Button>
  );

  const isVideo = clip.type === "video";
  const sped = isVideo && (clip.playbackRate ?? 1) !== 1;

  return (
    <Section title={t.footage}>
      {isVideo && action("detach", <Unlink className="h-3.5 w-3.5" />, t.detachAudio, () => void detach(), sped, sped ? t.detachAudioSpeed : undefined)}
      {isVideo && (
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            {action("freeze", <Snowflake className="h-3.5 w-3.5" />, t.freezeFrame, () => void freeze(), !underPlayhead, !underPlayhead ? t.playheadOutside : undefined)}
          </div>
          <NumberInput aria-label={t.holdFor} className="max-w-[64px] flex-none [&_input]:h-7" value={holdSecs} min={0.1} max={60} step={0.5} precision={1} suffix="s" onChange={(v) => setHoldSecs(v)} />
        </div>
      )}
      {isVideo && action("still", <Camera className="h-3.5 w-3.5" />, t.extractStill, () => void extract(), !underPlayhead, !underPlayhead ? t.playheadOutside : undefined)}
      <div className="mt-1 space-y-1.5 rounded-[6px] border border-bg-300/80 p-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-text-200">
          <AudioLines className="h-3.5 w-3.5 text-text-400" />
          {t.removeSilences}
        </div>
        <Row label={t.silenceThreshold}>
          <NumberInput aria-label={t.silenceThreshold} value={thresholdDb} min={-80} max={-10} suffix="dB" onChange={(v) => setThresholdDb(v)} />
        </Row>
        <Row label={t.minSilence}>
          <NumberInput aria-label={t.minSilence} value={minSilenceMs} min={100} max={10000} step={50} suffix="ms" onChange={(v) => setMinSilenceMs(v)} />
        </Row>
        <Row label={t.silencePadding}>
          <NumberInput aria-label={t.silencePadding} value={paddingMs} min={0} max={2000} step={10} suffix="ms" onChange={(v) => setPaddingMs(v)} />
        </Row>
        {action("silences", <Scissors className="h-3.5 w-3.5" />, t.removeSilences, () => void removeSilences())}
      </div>
      {note && <p className={note.error ? "text-[11.5px] leading-snug text-red-600 dark:text-red-400" : "text-[11.5px] leading-snug text-text-300"}>{note.text}</p>}
    </Section>
  );
}
