import type { Translations } from "@/locales/types";
import type { CardIcon, CardSlide, Localized } from "@/lib/updateCard";

interface Highlight { title: string; desc: string }

function stripMd(s: string): string {
  return s.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

/** The novelties and fixes in a release's notes (`## What's New` / `## Fixes` bullets). */
export function parseNotes(notes: string | null): { highlights: Highlight[]; fixes: string[] } {
  const highlights: Highlight[] = [];
  const fixes: string[] = [];
  if (!notes) return { highlights, fixes };

  let section: "feat" | "fix" | null = null;
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) {
      const t = heading[1].toLowerCase();
      if (/(fix|correc|bug|patch|arregl)/.test(t)) section = "fix";
      else if (/(feat|new|nov|highlight|add|mejor|improv|change|cambi)/.test(t)) section = "feat";
      else section = null;
      continue;
    }

    const bullet = line.match(/^[-*•]\s+(.*)/);
    if (!bullet) continue;
    const text = bullet[1].trim();

    if (section === "fix") {
      fixes.push(stripMd(text));
    } else {
      const m =
        text.match(/^\*\*(.+?)\*\*\s*[—–\-:]\s*(.*)$/) || text.match(/^(.+?)\s*[—–:]\s+(.*)$/);
      if (m) highlights.push({ title: stripMd(m[1]), desc: stripMd(m[2]) });
      else highlights.push({ title: stripMd(text), desc: "" });
    }
  }
  return { highlights, fixes };
}

const ICON_RULES: Array<[RegExp, CardIcon]> = [
  [/\b(terminal|pwsh|powershell|shell|command|comando)/i, "terminal"],
  [/\b(preview|panel|view|vista)/i, "panel"],
  [/\b(agent|agente|subagent)/i, "bot"],
  [/\b(voice|voz|mic|micr[oó]fono|transcri)/i, "mic"],
  [/\b(theme|tema|color|dark|light|claro|oscuro)/i, "palette"],
  [/\b(file|archivo|explorer|explorador|folder|carpeta)/i, "folder"],
  [/\b(search|b[uú]squeda|grep|filter|filtro)/i, "search"],
  [/\b(update|auto-?update|actualiz)/i, "refresh"],
  [/\b(chat|message|mensaje|conversa)/i, "message"],
  [/\b(speed|fast|r[aá]pid|overclock|tach|performance|rendimiento)/i, "gauge"],
  [/\b(group|agrup|layer|capa)/i, "layers"],
];

export function pickIcon(text: string): CardIcon {
  for (const [re, icon] of ICON_RULES) if (re.test(text)) return icon;
  return "sparkles";
}

/** A text the app wrote in the language on screen: `pickLang` falls back to it. */
const here = (s: string): Localized => ({ "en-US": s });

/**
 * Slides for a release whose notes carry no card (every release before the card existed):
 * each novelty with an icon, then the fixes as a list.
 */
export function slidesFromNotes(notes: string | null, t: Translations): CardSlide[] {
  const { highlights, fixes } = parseNotes(notes);
  const slides: CardSlide[] = highlights.slice(0, 4).map((h) => ({
    // Plain bullets have no title: the sentence goes where three lines fit.
    title: here(h.desc ? h.title : t.update.updateAvailable),
    desc: here(h.desc || h.title),
    scene: { kind: "icon", icon: pickIcon(`${h.title} ${h.desc}`) },
  }));
  if (fixes.length) {
    slides.push({
      title: here(t.update.fixesCount.replace("{count}", String(fixes.length))),
      desc: here(fixes[0]),
      scene: { kind: "list", items: fixes.slice(0, 2).map((f) => ({ tag: "fixed", text: here(f) })) },
    });
  }
  return slides;
}
