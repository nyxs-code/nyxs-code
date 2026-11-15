import type { Animatable } from "@/lib/video/timelineSchema";
import { adjacentKeys, hasKeyAt, isKeyframed, setValueAt, toggleKeyAt, valueAt } from "./animatable";
import { KeyframeControls, NumberInput, Row, type KeyframeLabels } from "./fields";

export interface AnimRowProps {
  label: string;
  value: Animatable<number> | undefined;
  fallback: number;
  /** The playhead relative to the clip's start. */
  frameInClip: number;
  onChange: (v: Animatable<number>, phase: "drag" | "commit") => void;
  onJump: (frameInClip: number) => void;
  labels: KeyframeLabels;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  suffix?: string;
  /** Shown value = stored value × factor (opacity 0..1 shown as 0..100 %). */
  factor?: number;
}

/** One animatable number: the value at the playhead, and its keyframe controls. Typing into a
 *  keyframed value writes the keyframe at the playhead. */
export function AnimRow({ label, value, fallback, frameInClip, onChange, onJump, labels, min, max, step, precision, suffix, factor = 1 }: AnimRowProps) {
  const current = valueAt(value, frameInClip, fallback);
  const { prev, next } = adjacentKeys(value, frameInClip);
  return (
    <Row label={label}>
      <NumberInput
        aria-label={label}
        value={current * factor}
        min={min}
        max={max}
        step={step}
        precision={precision}
        suffix={suffix}
        onChange={(v, phase) => onChange(setValueAt(value, frameInClip, v / factor), phase)}
      />
      <KeyframeControls
        keyed={hasKeyAt(value, frameInClip)}
        animated={isKeyframed(value)}
        prev={prev}
        next={next}
        onJump={onJump}
        onToggle={() => onChange(toggleKeyAt(value, frameInClip, fallback), "commit")}
        labels={labels}
      />
    </Row>
  );
}
