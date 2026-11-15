/** `HH:MM:SS:FF` for a frame at `fps` (non drop-frame). */
export function formatTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const rate = Math.max(1, Math.round(fps));
  const ff = f % rate;
  const totalSecs = Math.floor(f / rate);
  const ss = totalSecs % 60;
  const mm = Math.floor(totalSecs / 60) % 60;
  const hh = Math.floor(totalSecs / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(hh)}:${two(mm)}:${two(ss)}:${two(ff)}`;
}

/** A short duration for a badge: `0:07`, `1:02:05`. */
export function formatDuration(frames: number, fps: number): string {
  const secs = Math.max(0, Math.round(frames / Math.max(1, fps)));
  const s = secs % 60;
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Reads what the user typed in the timecode field: `HH:MM:SS:FF`, `MM:SS:FF`, `SS:FF`, a plain
 *  frame number, or seconds with an `s` suffix. Null when it isn't any of those. */
export function parseTimecode(text: string, fps: number): number | null {
  const s = text.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const secs = /^(\d+(?:\.\d+)?)s$/i.exec(s);
  if (secs) return Math.round(Number(secs[1]) * fps);
  if (!/^\d+(:\d+){1,3}$/.test(s)) return null;
  const parts = s.split(":").map(Number);
  while (parts.length < 4) parts.unshift(0);
  const [hh, mm, ss, ff] = parts;
  if (ff >= Math.max(1, Math.round(fps)) || ss >= 60 || mm >= 60) return null;
  return ((hh * 60 + mm) * 60 + ss) * Math.round(fps) + ff;
}

/** `ETA` text for the render queue: `12 s`, `3 min 05 s`. */
export function formatEta(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}
