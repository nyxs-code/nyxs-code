import { clipEnd, newId, validateTimeline, type Clip, type Track } from "@/lib/video/timelineSchema";

/**
 * Fixes the timeline.json mistakes the editor can fix without guessing: clips out of order on a
 * track (sorted by `from`), and clips that overlap on a track (each overlapping clip moves to a
 * new track of the same kind, right above, so nothing is lost or retimed). Returns the repaired
 * document and whether it now validates.
 */
export function repairTimelineJson(text: string): { json: string; ok: boolean; errors: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { json: text, ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const comps = (doc as { compositions?: unknown }).compositions;
  if (Array.isArray(comps)) {
    for (const comp of comps as { tracks?: Track[] }[]) {
      if (!Array.isArray(comp.tracks)) continue;
      const out: Track[] = [];
      for (const track of comp.tracks) {
        if (!track || !Array.isArray(track.clips)) {
          out.push(track);
          continue;
        }
        const sorted = [...track.clips].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
        // Greedy lanes: a clip goes on the first lane where it doesn't overlap.
        const lanes: Clip[][] = [];
        for (const clip of sorted) {
          const lane = lanes.find((l) => clipEnd(l[l.length - 1]) <= clip.from);
          if (lane) lane.push(clip);
          else lanes.push([clip]);
        }
        out.push({ ...track, clips: lanes[0] ?? [] });
        lanes.slice(1).forEach((clips, i) => out.push({ ...track, id: newId("track"), name: `${track.name} ${i + 2}`, clips }));
      }
      comp.tracks = out;
    }
  }
  const json = JSON.stringify(doc, null, 2) + "\n";
  const v = validateTimeline(JSON.parse(json));
  return { json, ok: v.ok, errors: v.ok ? [] : v.errors };
}
