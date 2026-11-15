import { useState } from "react";
import { Clapperboard } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Composition } from "@/lib/video/timelineSchema";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberInput, Select, Toggle } from "../inspector/fields";
import { formatDuration, formatTimecode } from "../timecode";
import { startRender, startStill } from "./renderJobs";
import { buildRenderOptions, CRF, EXT, FORMATS, SCALES, type Quality, type RangeKind, type RenderFormat } from "./renderOptions";


interface Props {
  open: boolean;
  onClose: () => void;
  workspace: string;
  slug: string;
  comp: Composition;
  playhead: number;
  inPoint: number | null;
  outPoint: number | null;
  /** Opens the queue once a render starts. */
  onStarted: () => void;
}

export function RenderDialog(props: Props) {
  if (!props.open) return null;
  return <RenderDialogBody {...props} />;
}

function RenderDialogBody({ onClose, workspace, slug, comp, playhead, inPoint, outPoint, onStarted }: Props) {
  const t = useTranslations().videoPanel;
  const [format, setFormat] = useState<RenderFormat>("h264");
  const [quality, setQuality] = useState<Quality>("high");
  const [scale, setScale] = useState(1);
  const markers = [...comp.markers].sort((a, b) => a.frame - b.frame);
  const hasInOut = inPoint !== null || outPoint !== null;
  const [range, setRange] = useState<RangeKind>(hasInOut ? "inout" : "all");
  const [markerFrom, setMarkerFrom] = useState(markers[0]?.id ?? "");
  const [markerTo, setMarkerTo] = useState(markers[1]?.id ?? markers[0]?.id ?? "");
  const [includeAudio, setIncludeAudio] = useState(true);
  const [gifFps, setGifFps] = useState(Math.min(15, comp.fps));
  const [name, setName] = useState(slugName(comp.name));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const last = comp.durationInFrames - 1;
  const frameRange = ((): [number, number] | null | "invalid" => {
    if (range === "all") return null;
    if (range === "inout") {
      if (!hasInOut) return "invalid";
      return [Math.max(0, inPoint ?? 0), Math.min(last, outPoint ?? last)];
    }
    const a = markers.find((m) => m.id === markerFrom)?.frame;
    const b = markers.find((m) => m.id === markerTo)?.frame;
    if (a === undefined || b === undefined || a === b) return "invalid";
    return [Math.min(a, b), Math.min(last, Math.max(a, b))];
  })();
  const frames = frameRange === "invalid" ? 0 : frameRange ? frameRange[1] - frameRange[0] + 1 : comp.durationInFrames;
  const isStill = format === "png";
  const canStart = !busy && name.trim().length > 0 && (isStill || frameRange !== "invalid");

  const start = async () => {
    setBusy(true);
    setError(null);
    const label = `${comp.name} · ${t.formats[format]}`;
    try {
      if (isStill) {
        void startStill(workspace, slug, label, comp.id, playhead, name.trim()).catch(() => {});
      } else {
        const opts = buildRenderOptions({
          format,
          quality,
          scale,
          range: frameRange === "invalid" ? null : frameRange,
          includeAudio,
          compositionId: comp.id,
          outputName: name.trim(),
          gifFps,
        });
        await startRender(workspace, slug, label, opts);
      }
      onStarted();
      onClose();
    } catch (e) {
      setError(t.renderFailed.replace("{error}", e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const outW = Math.round((comp.width * scale) / 2) * 2;
  const outH = Math.round((comp.height * scale) / 2) * 2;

  return (
    <Dialog open onClose={onClose} className="max-w-xl">
      <DialogHeader>
        <Clapperboard className="h-4 w-4 text-accent" />
        <DialogTitle>{t.renderTitle}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 overflow-y-auto px-4 pb-1 custom-scrollbar">
        <Field label={t.renderFormat}>
          <div role="radiogroup" aria-label={t.renderFormat} className="grid grid-cols-3 gap-1.5">
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                onClick={() => setFormat(f)}
                className={cn(
                  "rounded-[6px] border px-2.5 py-2 text-left transition-colors",
                  format === f ? "border-accent bg-accent/10" : "border-bg-300 hover:border-text-400 hover:bg-bg-200/50",
                )}
              >
                <span className="block text-[12.5px] font-medium text-text-100">{t.formats[f]}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-text-400">{t.formatHints[f]}</span>
              </button>
            ))}
          </div>
        </Field>

        {isStill ? (
          <p className="rounded-[6px] bg-bg-200/60 px-2.5 py-2 text-[12px] text-text-300">
            {t.stillAt.replace("{frame}", String(playhead))} · <span className="font-mono">{formatTimecode(playhead, comp.fps)}</span>
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              {CRF[format] && (
                <Field label={t.quality}>
                  <Seg
                    value={quality}
                    onChange={setQuality}
                    options={[
                      { value: "high", label: t.qualityHigh },
                      { value: "medium", label: t.qualityMedium },
                      { value: "low", label: t.qualityLow },
                    ]}
                  />
                </Field>
              )}
              <Field label={t.resolution}>
                <Select
                  aria-label={t.resolution}
                  value={String(scale)}
                  onChange={(v) => setScale(Number(v))}
                  options={SCALES.map((s) => ({
                    value: String(s),
                    label: `${Math.round((comp.width * s) / 2) * 2}×${Math.round((comp.height * s) / 2) * 2} · ${s * 100}%`,
                  }))}
                  className="[&_select]:h-7"
                />
              </Field>
              {format === "gif" && (
                <Field label={t.fps}>
                  <NumberInput aria-label={t.fps} value={gifFps} min={1} max={comp.fps} onChange={(v) => setGifFps(v)} className="[&_input]:h-7" />
                </Field>
              )}
            </div>

            <Field label={t.range}>
              <Seg
                value={range}
                onChange={setRange}
                options={[
                  { value: "all", label: t.rangeAll },
                  { value: "inout", label: t.rangeInOut },
                  { value: "markers", label: t.rangeMarkers },
                ]}
              />
              {range === "inout" && !hasInOut && <p className="mt-1.5 text-[11.5px] text-amber-600 dark:text-amber-400">{t.noInOut}</p>}
              {range === "markers" && markers.length < 2 && <p className="mt-1.5 text-[11.5px] text-amber-600 dark:text-amber-400">{t.noMarkers}</p>}
              {range === "markers" && markers.length >= 2 && (
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {([
                    [t.rangeFrom, markerFrom, setMarkerFrom],
                    [t.rangeTo, markerTo, setMarkerTo],
                  ] as const).map(([label, value, set]) => (
                    <Select
                      key={label}
                      aria-label={label}
                      value={value}
                      onChange={set}
                      options={markers.map((m) => ({ value: m.id, label: `${m.label || formatTimecode(m.frame, comp.fps)} · ${m.frame}` }))}
                      className="[&_select]:h-7"
                    />
                  ))}
                </div>
              )}
              {frameRange !== "invalid" && (
                <p className="mt-1.5 text-[11.5px] tabular-nums text-text-400">
                  {frameRange ? `${formatTimecode(frameRange[0], comp.fps)} → ${formatTimecode(frameRange[1], comp.fps)} · ` : ""}
                  {formatDuration(frames, comp.fps)} · {outW}×{outH} · {format === "gif" ? gifFps : comp.fps} fps
                </p>
              )}
            </Field>

            {format !== "gif" && (
              <label className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] text-text-200">{t.includeAudio}</span>
                <Toggle on={includeAudio} onChange={setIncludeAudio} label={t.includeAudio} />
              </label>
            )}
          </>
        )}

        <Field label={t.outputName} hint={t.outputHint}>
          <div className="flex h-7 items-center rounded-[6px] border border-bg-300 bg-bg-0 focus-within:border-accent/70">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canStart) void start();
              }}
              aria-label={t.outputName}
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent px-2 text-[12.5px] text-text-100 outline-none"
            />
            <span className="pr-2 font-mono text-[12px] text-text-400">.{EXT[format]}</span>
          </div>
        </Field>
        {error && <p className="rounded-[6px] bg-red-500/10 px-2.5 py-2 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        <Button variant="primary" onClick={() => void start()} disabled={!canStart}>
          {t.startRender}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function slugName(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "video";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-text-200">{label}</span>
        {hint && <span className="truncate text-[11px] text-text-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Seg<V extends string>({ value, onChange, options }: { value: V; onChange: (v: V) => void; options: { value: V; label: string }[] }) {
  return (
    <div role="radiogroup" className="flex h-7 rounded-[6px] border border-bg-300 bg-bg-0 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-w-0 flex-1 truncate rounded-[4px] px-1.5 text-[12px] transition-colors",
            value === o.value ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
