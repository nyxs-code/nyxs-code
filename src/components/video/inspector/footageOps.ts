import { addTrack, contentEnd, getComposition, locateClip, moveClips, placeClip, splitClip, updateClip, updateComposition } from "@/lib/video/timelineOps";
import { clipEnd, newId, type Asset, type AudioClip, type Clip, type Timeline } from "@/lib/video/timelineSchema";

/** "Detach audio": the video clip's sound moves to its own clip on an audio track (same asset,
 *  timing and trim), and the video clip is silenced. Null when the clip isn't a video. */
export function detachAudio(tl: Timeline, compId: string, clipId: string): { timeline: Timeline; audioClipId: string } | null {
  const comp = getComposition(tl, compId);
  const loc = comp ? locateClip(comp, clipId) : null;
  if (!comp || !loc || loc.clip.type !== "video" || loc.track.locked) return null;
  const v = loc.clip;
  // A sped-up clip's audio would play at the wrong speed on an audio clip (they have no rate).
  if ((v.playbackRate ?? 1) !== 1) return null;
  const audio: AudioClip = {
    id: newId("clip"),
    type: "audio",
    assetId: v.assetId,
    from: v.from,
    durationInFrames: v.durationInFrames,
    trimStart: v.trimStart,
    name: v.name ? `${v.name} (audio)` : undefined,
    ...(v.volume !== undefined ? { volume: v.volume } : {}),
  };
  if (!audio.name) delete audio.name;
  const muted = updateClip(tl, compId, clipId, { volume: 0 });
  // The audio clip must land exactly under the video: a free audio track at that span, or a new one.
  let r = placeClip(muted, compId, audio, null);
  const placed = r.clipId ? locateClip(getComposition(r.timeline, compId)!, r.clipId) : null;
  if (!placed || placed.clip.from !== audio.from) {
    const added = addTrack(muted, compId, "audio");
    r = placeClip(added.timeline, compId, audio, added.trackId);
  }
  return r.clipId ? { timeline: r.timeline, audioClipId: r.clipId } : null;
}

/**
 * Freeze frame: splits the clip at `frame`, pushes the rest of its track right by
 * `holdFrames`, and fills the gap with `image` (a still of that frame), keeping the clip's
 * transform, fit and effects so the hold looks identical. Other tracks are not moved (like an
 * insert on one track); the composition grows to fit.
 */
export function insertHold(tl: Timeline, compId: string, clipId: string, frame: number, image: Asset, holdFrames: number): { timeline: Timeline; holdClipId: string } | null {
  const comp = getComposition(tl, compId);
  const loc = comp ? locateClip(comp, clipId) : null;
  const hold = Math.max(1, Math.round(holdFrames));
  if (!comp || !loc || loc.track.locked || loc.clip.type !== "video") return null;
  if (frame < loc.clip.from || frame >= clipEnd(loc.clip)) return null;
  const trackId = loc.track.id;
  const v = loc.clip;

  let t = updateComposition(tl, compId, { durationInFrames: Math.max(comp.durationInFrames, contentEnd(comp)) + hold });
  if (frame > v.from) t = splitClip(t, compId, clipId, frame).timeline;
  const track = getComposition(t, compId)!.tracks.find((x) => x.id === trackId)!;
  const later = track.clips.filter((c) => c.from >= frame).map((c) => c.id);
  if (later.length) t = moveClips(t, compId, later, hold);

  const still: Clip = {
    id: newId("clip"),
    type: "image",
    assetId: image.id,
    from: frame,
    durationInFrames: hold,
    name: image.name,
    ...(v.transform ? { transform: v.transform } : {}),
    ...(v.fit ? { fit: v.fit } : {}),
    ...(v.effects ? { effects: v.effects } : {}),
  };
  const r = placeClip(t, compId, still, trackId);
  return r.clipId ? { timeline: r.timeline, holdClipId: r.clipId } : null;
}
