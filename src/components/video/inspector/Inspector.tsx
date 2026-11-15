import { MousePointer2 } from "lucide-react";
import { useTranslations, type Translations } from "@/lib/i18n";
import { locateClip } from "@/lib/video/timelineOps";
import { timelineActions, usePlayhead, useTimelineStore } from "@/lib/video/timelineStore";
import type { Composition } from "@/lib/video/timelineSchema";
import { formatTimecode } from "../timecode";
import { ClipInspector } from "./ClipInspector";
import { ColorInput, NumberInput, Row, Section, Select, TextInput } from "./fields";

const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 60];

/** The right column: the selected clip's properties, or the composition's when nothing is
 *  selected. */
export function Inspector({ workspace, slug }: { workspace: string; slug: string }) {
  const t = useTranslations().videoPanel;
  const timeline = useTimelineStore((s) => s.timeline);
  const compositionId = useTimelineStore((s) => s.compositionId);
  const selection = useTimelineStore((s) => s.selection.clipIds);
  const playhead = usePlayhead();
  const comp = timeline?.compositions.find((c) => c.id === compositionId) ?? null;
  if (!timeline || !comp) return null;

  let body;
  if (selection.length > 1) {
    body = (
      <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
        <MousePointer2 className="h-5 w-5 text-text-400" />
        <p className="text-[13px] text-text-200">{t.multipleSelected.replace("{n}", String(selection.length))}</p>
        <p className="text-[12px] text-text-400">{t.multipleHint}</p>
      </div>
    );
  } else {
    const loc = selection.length === 1 ? locateClip(comp, selection[0]) : null;
    body = loc ? (
      <ClipInspector key={loc.clip.id} clip={loc.clip} comp={comp} timeline={timeline} playhead={playhead} workspace={workspace} slug={slug} />
    ) : (
      <CompositionInspector comp={comp} t={t} />
    );
  }

  return <div className="h-full overflow-y-auto custom-scrollbar">{body}</div>;
}

function CompositionInspector({ comp, t }: { comp: Composition; t: Translations["videoPanel"] }) {
  const set = (patch: Partial<Omit<Composition, "id" | "tracks" | "markers">>, key: string) =>
    timelineActions.updateComposition(patch, `inspector:comp:${comp.id}:${key}`);
  const fpsOptions = FPS_OPTIONS.includes(comp.fps) ? FPS_OPTIONS : [...FPS_OPTIONS, comp.fps].sort((a, b) => a - b);
  return (
    <Section title={t.compositionSettings}>
      <Row label={t.clipName}>
        <TextInput aria-label={t.clipName} value={comp.name} onCommit={(name) => name.trim() && set({ name: name.trim() }, "name")} />
      </Row>
      <Row label={`${t.width} · ${t.height}`}>
        <NumberInput aria-label={t.width} value={comp.width} min={16} max={7680} step={2} suffix="px" onChange={(width, p) => p === "commit" && set({ width: even(width) }, "width")} />
        <NumberInput aria-label={t.height} value={comp.height} min={16} max={7680} step={2} suffix="px" onChange={(height, p) => p === "commit" && set({ height: even(height) }, "height")} />
      </Row>
      <Row label={t.fps}>
        <Select aria-label={t.fps} value={String(comp.fps)} options={fpsOptions.map((f) => ({ value: String(f), label: String(f) }))} onChange={(f) => set({ fps: Number(f) }, "fps")} />
      </Row>
      <Row label={t.duration}>
        <NumberInput aria-label={t.duration} value={comp.durationInFrames} min={1} suffix="f" onChange={(d, p) => p === "commit" && set({ durationInFrames: d }, "duration")} />
      </Row>
      <Row label="">
        <span className="font-mono text-[11.5px] tabular-nums text-text-400">{formatTimecode(comp.durationInFrames, comp.fps)}</span>
      </Row>
      <Row label={t.background}>
        <ColorInput aria-label={t.background} value={comp.background} onChange={(c) => c && set({ background: c }, "background")} />
      </Row>
    </Section>
  );
}

/** H.264 needs even dimensions. */
function even(n: number) {
  return Math.max(2, Math.round(n / 2) * 2);
}
