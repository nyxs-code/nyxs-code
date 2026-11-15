import { useState } from "react";
import { Clapperboard } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { VideoPreset } from "@/lib/video/videoApi";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberInput } from "./inspector/fields";

type PresetId = "landscape" | "landscape4k" | "vertical" | "square" | "portrait";

const PRESETS: { id: PresetId; width: number; height: number }[] = [
  { id: "landscape", width: 1920, height: 1080 },
  { id: "landscape4k", width: 3840, height: 2160 },
  { id: "vertical", width: 1080, height: 1920 },
  { id: "square", width: 1080, height: 1080 },
  { id: "portrait", width: 1080, height: 1350 },
];

const FPS = [24, 25, 30, 60];

/** The aspect of a preset as a small outline, so the choice reads at a glance. */
function AspectGlyph({ width, height }: { width: number; height: number }) {
  const max = 22;
  const w = width >= height ? max : Math.round((max * width) / height);
  const h = height >= width ? max : Math.round((max * height) / width);
  return (
    <span className="flex h-6 w-6 items-center justify-center">
      <span className="rounded-[2px] border-[1.5px] border-current" style={{ width: w, height: h }} />
    </span>
  );
}

export function NewVideoDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (name: string, preset: VideoPreset) => void }) {
  if (!open) return null;
  return <NewVideoBody onClose={onClose} onCreate={onCreate} />;
}

function NewVideoBody({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, preset: VideoPreset) => void }) {
  const t = useTranslations().videoPanel;
  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState<PresetId>("landscape");
  const [fps, setFps] = useState(30);
  const [seconds, setSeconds] = useState(10);
  const preset = PRESETS.find((p) => p.id === presetId)!;
  const labels: Record<PresetId, string> = {
    landscape: t.presetLandscape,
    landscape4k: t.presetLandscape4k,
    vertical: t.presetVertical,
    square: t.presetSquare,
    portrait: t.presetPortrait,
  };

  // Creating runs npm install, which takes a while: the view shows its progress, not the dialog.
  const create = () => {
    onCreate(name.trim() || t.namePlaceholder, { width: preset.width, height: preset.height, fps, durationInFrames: Math.max(1, Math.round(seconds * fps)) });
    onClose();
  };

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <Clapperboard className="h-4 w-4 text-accent" />
        <DialogTitle>{t.newVideoTitle}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 px-4 pb-1">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-200">{t.name}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
            placeholder={t.namePlaceholder}
            className="h-8 w-full rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 text-[13px] text-text-100 outline-none placeholder:text-text-400 focus:border-accent/70"
          />
        </label>
        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-text-200">{t.format}</span>
          <div role="radiogroup" aria-label={t.format} className="grid grid-cols-5 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={presetId === p.id}
                onClick={() => setPresetId(p.id)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-[6px] border px-1 py-2 transition-colors",
                  presetId === p.id ? "border-accent bg-accent/10 text-accent" : "border-bg-300 text-text-300 hover:border-text-400 hover:bg-bg-200/50",
                )}
              >
                <AspectGlyph width={p.width} height={p.height} />
                <span className="text-[11.5px] font-medium text-text-100">{labels[p.id]}</span>
                <span className="text-[10.5px] tabular-nums text-text-400">{p.width}×{p.height}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-text-200">{t.frameRate}</span>
            <div role="radiogroup" aria-label={t.frameRate} className="flex h-7 rounded-[6px] border border-bg-300 bg-bg-0 p-0.5">
              {FPS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={fps === f}
                  onClick={() => setFps(f)}
                  className={cn("flex-1 rounded-[4px] text-[12px] tabular-nums transition-colors", fps === f ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100")}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-text-200">{t.duration}</span>
            <NumberInput aria-label={t.duration} value={seconds} min={1} max={3600} suffix={t.seconds} onChange={(v) => setSeconds(v)} className="[&_input]:h-7 [&_input]:pr-16" />
          </div>
        </div>
        <p className="text-[11.5px] tabular-nums text-text-400">{t.sizeFps.replace("{w}", String(preset.width)).replace("{h}", String(preset.height)).replace("{fps}", String(fps))} · {Math.round(seconds * fps)} {t.frames}</p>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        <Button variant="primary" onClick={create}>
          {t.create}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
