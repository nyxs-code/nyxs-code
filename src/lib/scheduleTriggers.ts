/** How often a scheduled task runs, as the form picks it; stored as a cron expression. */
export type Frequency = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export interface Trigger {
  frequency: Frequency;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday, for "weekly". */
  weekday: number;
  /** 1–31, for "monthly". */
  monthDay: number;
  /** The expression itself, for "custom". */
  cron: string;
}

export const DEFAULT_TRIGGER: Trigger = { frequency: "daily", hour: 9, minute: 0, weekday: 1, monthDay: 1, cron: "0 9 * * *" };

const int = (s: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};

export function toCron(t: Trigger): string {
  switch (t.frequency) {
    case "hourly":
      return `${t.minute} * * * *`;
    case "daily":
      return `${t.minute} ${t.hour} * * *`;
    case "weekdays":
      return `${t.minute} ${t.hour} * * 1-5`;
    case "weekly":
      return `${t.minute} ${t.hour} * * ${t.weekday}`;
    case "monthly":
      return `${t.minute} ${t.hour} ${t.monthDay} * *`;
    default:
      return t.cron.trim();
  }
}

/** The form's reading of a cron expression; anything it can't show as a choice stays "custom". */
export function fromCron(expr: string): Trigger {
  const cron = expr.trim().replace(/\s+/g, " ");
  const base = { ...DEFAULT_TRIGGER, cron };
  const parts = cron.split(" ");
  if (parts.length !== 5) return { ...base, frequency: "custom" };
  const [mi, h, dom, mon, dow] = parts;
  const minute = int(mi, 0, 59);
  if (minute === null || mon !== "*") return { ...base, frequency: "custom" };
  if (h === "*" && dom === "*" && dow === "*") return { ...base, frequency: "hourly", minute };
  const hour = int(h, 0, 23);
  if (hour === null) return { ...base, frequency: "custom" };
  const at = { ...base, minute, hour };
  if (dom === "*" && dow === "*") return { ...at, frequency: "daily" };
  if (dom === "*" && dow === "1-5") return { ...at, frequency: "weekdays" };
  const wd = int(dow, 0, 7);
  if (dom === "*" && wd !== null) return { ...at, frequency: "weekly", weekday: wd % 7 };
  const md = int(dom, 1, 31);
  if (dow === "*" && md !== null) return { ...at, frequency: "monthly", monthDay: md };
  return { ...base, frequency: "custom" };
}

/** "7:05", in the 24-hour form Claude's schedule lines use. */
export function clock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

export interface ScheduleWords {
  hourly: string;
  daily: string;
  weekdays: string;
  weekly: string;
  monthly: string;
  custom: string;
}

/** A line like "Weekdays at 7:18", from templates where `{time}`, `{day}` and `{cron}` go. */
export function describeTrigger(t: Trigger, words: ScheduleWords, weekdayNames: string[]): string {
  const time = clock(t.hour, t.minute);
  const fill = (s: string) =>
    s
      .replace("{time}", time)
      .replace("{minute}", String(t.minute).padStart(2, "0"))
      .replace("{day}", t.frequency === "weekly" ? weekdayNames[t.weekday] ?? "" : String(t.monthDay))
      .replace("{cron}", t.cron);
  return fill(words[t.frequency]);
}

/** The weekday names of a language, Sunday first, from the platform's own calendar. */
export function weekdayNames(locale: string, style: "long" | "short" = "long"): string[] {
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2023, 0, 1 + i).toLocaleDateString(locale, { weekday: style }),
  );
}
