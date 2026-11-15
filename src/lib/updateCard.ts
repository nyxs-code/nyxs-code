import type { LangCode } from "@/locales/types";
import type { MascotMood } from "@/lib/mascotMood";

/**
 * The update card's slides: what each novelty of a release shows in the card that offers the
 * update. The card is drawn by the version still installed, so a demo can't be code of the new
 * one: it travels as data (a `card` in the release's `src/lib/changelog.ts` entry, embedded in
 * the release notes by `scripts/release-notes.mjs`) and the installed app draws it with the
 * scenes it knows. A scene kind it doesn't know falls back to an icon.
 *
 * How to write one: `.claude/skills/nyxs-update-card/SKILL.md`.
 */

export const CARD_LANGS: LangCode[] = ["en-US", "es-ES", "fr-FR", "de-DE", "it-IT", "pt-BR", "id-ID", "ja-JP", "ko-KR", "hi-IN"];

/** A text in every language the app speaks; `en-US` is the fallback. */
export type Localized = { "en-US": string } & Partial<Record<LangCode, string>>;

export const CARD_POSES = ["rest", "think", "search", "code", "celebrate", "sad", "shy", "wave", "surprised", "sleep", "intro"] as const satisfies readonly MascotMood[];
export type CardPose = (typeof CARD_POSES)[number];

export const CARD_ICONS = [
  "sparkles", "terminal", "panel", "bot", "mic", "palette", "folder", "search", "refresh", "message",
  "gauge", "layers", "image", "file", "pointer", "globe", "git", "bell", "keyboard", "shield", "zap", "wrench",
] as const;
export type CardIcon = (typeof CARD_ICONS)[number];

export type CardTag = "new" | "improved" | "fixed";
export type TerminalLine = { kind: "cmd" | "ok" | "add" | "out"; text: string };

export type CardScene =
  /** The mascot on a small message box, going through poses, each with a status line above. */
  | { kind: "mascot"; steps: { pose: CardPose; label?: Localized }[]; placeholder?: Localized }
  /** Phrases typed in the message box, each answered by a pose. */
  | { kind: "reactions"; steps: { text: Localized; pose: CardPose }[] }
  /** A reply to a quoted selection: the quote, then a box with voice and/or attachments. */
  | { kind: "reply"; quote: Localized; voice?: boolean; attach?: { icon: CardIcon; label: string }[] }
  /** A page in the browser with one element picked (its selector shown above it). */
  | { kind: "browser"; url: string; element: Localized; selector: string }
  /** A few lines of a terminal, shown one after another. */
  | { kind: "terminal"; lines: TerminalLine[] }
  /** Short tagged lines: the improvements or fixes that have no demo of their own. */
  | { kind: "list"; items: { tag: CardTag; text: Localized }[] }
  /** One icon, for a novelty with nothing better to show. */
  | { kind: "icon"; icon: CardIcon };

export type CardSceneKind = CardScene["kind"];

export interface CardSlide {
  title: Localized;
  desc: Localized;
  scene: CardScene;
}

export interface UpdateCardSpec {
  v: 1;
  slides: CardSlide[];
}

/**
 * Rough caps, checked by the unit test. What really decides is the E2E audit
 * (`e2e/tests/updateCard.spec.ts`), which measures every text in every language at the
 * narrowest sidebar: a German or Hindi text under the cap can still not fit.
 */
export const CARD_LIMITS = {
  slides: 6,
  title: 34,
  desc: 110,
  steps: 4,
  stepLabel: 26,
  placeholder: 30,
  reactions: 3,
  reactionText: 24,
  quote: 36,
  attach: 2,
  attachLabel: 16,
  url: 28,
  element: 18,
  selector: 20,
  lines: 4,
  line: 32,
  items: 2,
  item: 64,
} as const;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

function localized(x: unknown): Localized | null {
  if (!isObj(x) || !str(x["en-US"])) return null;
  const out: Record<string, string> = {};
  for (const lang of CARD_LANGS) {
    const s = str(x[lang]);
    if (s) out[lang] = s;
  }
  return out as Localized;
}

const pose = (x: unknown): CardPose => ((CARD_POSES as readonly unknown[]).includes(x) ? (x as CardPose) : "rest");
const icon = (x: unknown): CardIcon => ((CARD_ICONS as readonly unknown[]).includes(x) ? (x as CardIcon) : "sparkles");
const list = (x: unknown, max: number): unknown[] => (Array.isArray(x) ? x.slice(0, max) : []);

function scene(x: unknown): CardScene {
  const fallback: CardScene = { kind: "icon", icon: "sparkles" };
  if (!isObj(x)) return fallback;
  switch (x.kind) {
    case "mascot": {
      const steps = list(x.steps, CARD_LIMITS.steps).filter(isObj).map((s) => {
        const label = localized(s.label);
        return label ? { pose: pose(s.pose), label } : { pose: pose(s.pose) };
      });
      if (!steps.length) return fallback;
      const placeholder = localized(x.placeholder);
      return placeholder ? { kind: "mascot", steps, placeholder } : { kind: "mascot", steps };
    }
    case "reactions": {
      const steps = list(x.steps, CARD_LIMITS.reactions).filter(isObj).flatMap((s) => {
        const text = localized(s.text);
        return text ? [{ text, pose: pose(s.pose) }] : [];
      });
      return steps.length ? { kind: "reactions", steps } : fallback;
    }
    case "reply": {
      const quote = localized(x.quote);
      if (!quote) return fallback;
      const attach = list(x.attach, CARD_LIMITS.attach).filter(isObj).flatMap((a) => {
        const label = str(a.label);
        return label ? [{ icon: icon(a.icon), label }] : [];
      });
      return { kind: "reply", quote, ...(x.voice === true ? { voice: true } : {}), ...(attach.length ? { attach } : {}) };
    }
    case "browser": {
      const url = str(x.url);
      const element = localized(x.element);
      const selector = str(x.selector);
      return url && element && selector ? { kind: "browser", url, element, selector } : fallback;
    }
    case "terminal": {
      const kinds = ["cmd", "ok", "add", "out"];
      const lines = list(x.lines, CARD_LIMITS.lines).filter(isObj).flatMap((l): TerminalLine[] => {
        const text = str(l.text);
        return text ? [{ kind: (kinds.includes(l.kind as string) ? l.kind : "out") as TerminalLine["kind"], text }] : [];
      });
      return lines.length ? { kind: "terminal", lines } : fallback;
    }
    case "list": {
      const tags = ["new", "improved", "fixed"];
      const items = list(x.items, CARD_LIMITS.items).filter(isObj).flatMap((it) => {
        const text = localized(it.text);
        return text ? [{ tag: (tags.includes(it.tag as string) ? it.tag : "new") as CardTag, text }] : [];
      });
      return items.length ? { kind: "list", items } : fallback;
    }
    case "icon":
      return { kind: "icon", icon: icon(x.icon) };
    default:
      // A scene kind a newer Nyxs added: this one shows the slide with an icon.
      return fallback;
  }
}

/**
 * The card as this app can draw it, from whatever the notes carried: slides without a title
 * or description are dropped, counts are capped and unknown values replaced. Never throws.
 */
export function sanitizeCard(raw: unknown): UpdateCardSpec | null {
  if (!isObj(raw)) return null;
  const slides = list(raw.slides, CARD_LIMITS.slides).filter(isObj).flatMap((s) => {
    const title = localized(s.title);
    const desc = localized(s.desc);
    return title && desc ? [{ title, desc, scene: scene(s.scene) }] : [];
  });
  return slides.length ? { v: 1, slides } : null;
}

const OPEN = "<!-- nyxs-card ";
const CLOSE = " -->";

/** The card as the HTML comment the release notes end with: GitHub's release page hides it,
 *  and versions of Nyxs without the card skip a line that isn't a heading or a bullet.
 *  `--` can't appear inside a comment, so it is written as a JSON escape. Keep in step with
 *  `scripts/release-notes.mjs`. */
export function cardComment(spec: UpdateCardSpec): string {
  return `${OPEN}${JSON.stringify(spec).replace(/--/g, "-\\u002d")}${CLOSE}`;
}

export function cardFromNotes(notes: string | null | undefined): UpdateCardSpec | null {
  if (!notes) return null;
  const start = notes.indexOf(OPEN);
  if (start < 0) return null;
  const end = notes.indexOf(CLOSE, start + OPEN.length);
  if (end < 0) return null;
  try {
    return sanitizeCard(JSON.parse(notes.slice(start + OPEN.length, end)));
  } catch {
    return null;
  }
}

export function pickLang(text: Localized, lang: LangCode): string {
  return text[lang] ?? text["en-US"];
}

/** Steps a scene goes through; the audit draws each one, since each shows different text. */
export function scenePhases(s: CardScene): number {
  return s.kind === "mascot" || s.kind === "reactions" ? s.steps.length : 1;
}

/** Every text a card holds with where it is, for the length checks. */
export function cardTexts(spec: UpdateCardSpec): { where: string; text: Localized | string; max: number }[] {
  const out: { where: string; text: Localized | string; max: number }[] = [];
  spec.slides.forEach((slide, i) => {
    const at = `slide ${i + 1}`;
    out.push({ where: `${at} title`, text: slide.title, max: CARD_LIMITS.title });
    out.push({ where: `${at} desc`, text: slide.desc, max: CARD_LIMITS.desc });
    const s = slide.scene;
    if (s.kind === "mascot") {
      s.steps.forEach((st, j) => st.label && out.push({ where: `${at} step ${j + 1} label`, text: st.label, max: CARD_LIMITS.stepLabel }));
      if (s.placeholder) out.push({ where: `${at} placeholder`, text: s.placeholder, max: CARD_LIMITS.placeholder });
    } else if (s.kind === "reactions") {
      s.steps.forEach((st, j) => out.push({ where: `${at} reaction ${j + 1}`, text: st.text, max: CARD_LIMITS.reactionText }));
    } else if (s.kind === "reply") {
      out.push({ where: `${at} quote`, text: s.quote, max: CARD_LIMITS.quote });
      s.attach?.forEach((a, j) => out.push({ where: `${at} attachment ${j + 1}`, text: a.label, max: CARD_LIMITS.attachLabel }));
    } else if (s.kind === "browser") {
      out.push({ where: `${at} url`, text: s.url, max: CARD_LIMITS.url });
      out.push({ where: `${at} element`, text: s.element, max: CARD_LIMITS.element });
      out.push({ where: `${at} selector`, text: s.selector, max: CARD_LIMITS.selector });
    } else if (s.kind === "terminal") {
      s.lines.forEach((l, j) => out.push({ where: `${at} line ${j + 1}`, text: l.text, max: CARD_LIMITS.line }));
    } else if (s.kind === "list") {
      s.items.forEach((it, j) => out.push({ where: `${at} item ${j + 1}`, text: it.text, max: CARD_LIMITS.item }));
    }
  });
  return out;
}

/**
 * What is wrong with a card written in the changelog: anything `sanitizeCard` would change,
 * a language missing, a text over its cap. Empty when it is ready to ship.
 */
export function cardProblems(spec: UpdateCardSpec): string[] {
  const problems: string[] = [];
  // Key order doesn't matter, only what sanitizing keeps.
  const canon = (x: unknown): string =>
    Array.isArray(x)
      ? `[${x.map(canon).join(",")}]`
      : isObj(x)
        ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(",")}}`
        : JSON.stringify(x);
  if (canon(sanitizeCard(JSON.parse(JSON.stringify(spec)))) !== canon(spec)) {
    problems.push("the card has values the app would drop or replace (unknown pose, icon or kind, empty text, too many items)");
  }
  for (const { where, text, max } of cardTexts(spec)) {
    const versions = typeof text === "string" ? [["any", text] as const] : CARD_LANGS.map((l) => [l, text[l]] as const);
    for (const [lang, value] of versions) {
      if (!value) problems.push(`${where}: missing ${lang}`);
      else if ([...value].length > max) problems.push(`${where} (${lang}) has ${[...value].length} characters, over ${max}: "${value}"`);
    }
  }
  return problems;
}
