export function relativeTime(ms: number, locale?: string): string {
  const diffSec = Math.round((Date.now() - ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const min = Math.round(diffSec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);

  if (diffSec < 45) return rtf.format(-Math.max(diffSec, 1), "second");
  if (min < 45) return rtf.format(-min, "minute");
  if (hr < 24) return rtf.format(-hr, "hour");
  if (day < 7) return rtf.format(-day, "day");
  return new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/** How long ago, in one short token: "now", "5m", "3h", "7d", "4w", "2y". */
export function shortAge(ms: number, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - ms) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  if (day < 365) return `${Math.floor(day / 7)}w`;
  return `${Math.floor(day / 365)}y`;
}

export function fullDateTime(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}
