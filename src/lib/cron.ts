export interface CronSpec {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  domStar: boolean;
  dowStar: boolean;
}

interface FieldRange {
  min: number;
  max: number;
}

const FIELDS: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day-of-week
];

function parseField(token: string, range: FieldRange): number[] | null {
  const out = new Set<number>();
  for (const part of token.split(",")) {
    const t = part.trim();
    if (!t) return null;
    let stepBase = t;
    let step = 1;
    const slash = t.indexOf("/");
    if (slash !== -1) {
      stepBase = t.slice(0, slash);
      step = Number(t.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let lo: number;
    let hi: number;
    if (stepBase === "*") {
      lo = range.min;
      hi = range.max;
    } else if (stepBase.includes("-")) {
      const [a, b] = stepBase.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(stepBase);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < range.min || hi > range.max || lo > hi) {
      return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronSpec | null {
  const tokens = (expr ?? "").trim().split(/\s+/);
  if (tokens.length !== 5) return null;
  const fields = tokens.map((tok, i) => parseField(tok, FIELDS[i]));
  if (fields.some((f) => f === null)) return null;
  const [minute, hour, dom, month, dow] = fields as number[][];
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domStar: tokens[2] === "*",
    dowStar: tokens[4] === "*",
  };
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.includes(date.getMinutes())) return false;
  if (!spec.hour.includes(date.getHours())) return false;
  if (!spec.month.includes(date.getMonth() + 1)) return false;
  const domHit = spec.dom.includes(date.getDate());
  const dowHit = spec.dow.includes(date.getDay());
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowHit;
  if (spec.dowStar) return domHit;
  return domHit || dowHit;
}

const MAX_SCAN_MINUTES = 366 * 24 * 60;

export function nextRun(spec: CronSpec, after: Date): Date | null {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (cronMatches(spec, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
