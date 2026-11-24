import { createElement, useState } from "react";
import {
  Bot, BookOpen, Clapperboard, Cloud, Code2, Database, FileText, FlaskConical, GitPullRequest,
  Megaphone, Paintbrush, Palette, Puzzle, ScrollText, ShieldCheck, Smartphone, Telescope, Wallet,
  Workflow, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** First rule whose words appear in the plugin's name, category or keywords picks its glyph. */
const GLYPHS: [RegExp, LucideIcon][] = [
  [/theme|backdrop|wallpaper|colou?r/, Paintbrush],
  [/motion|anim|video|film/, Clapperboard],
  [/design|\bui\b|\bux\b|figma|logo|brand|\bart\b|canvas|image|visual|icon|font/, Palette],
  [/secur|vuln|audit|\bsast\b|secret|\bauth\b|compliance/, ShieldCheck],
  [/\btest|\bqa\b|playwright|e2e|coverage/, FlaskConical],
  [/data|sql|database|postgres|mongo|analytic|bigquery|warehouse/, Database],
  [/research|search|explore|discover/, Telescope],
  [/deploy|cloud|infra|devops|kubernetes|aws|azure|gcp|docker|serverless/, Cloud],
  [/\bgit|pull.?request|code.?review|commit/, GitPullRequest],
  [/automat|workflow|n8n|zapier|pipeline|orchestr/, Workflow],
  [/finance|payment|stripe|invoice|billing|account/, Wallet],
  [/market|sales|\bcrm\b|\bseo\b|\bads\b|campaign/, Megaphone],
  [/mobile|ios|android|swift|kotlin/, Smartphone],
  [/memory|note|knowledge|learn|wiki/, BookOpen],
  [/doc|writ|comms|content|blog|copy|pdf|docx|slide|report/, FileText],
  [/agent|sdk|llm|model|ai\b|prompt|mcp/, Bot],
  [/skill/, ScrollText],
  [/code|dev|engineer|lint|refactor|typescript|python|rust|java|lsp/, Code2],
];

function pluginGlyph(text: string): LucideIcon {
  const hay = text.toLowerCase();
  return GLYPHS.find(([re]) => re.test(hay))?.[1] ?? Puzzle;
}

/**
 * A plugin's logo: a neutral gray tile, the same for every plugin as in Claude's app, with a
 * glyph for what it does.
 */
export function PluginLogo({
  name,
  hints = "",
  size = 36,
  className,
}: {
  name: string;
  /** Category, keywords and description: they pick the glyph. */
  hints?: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 rounded-[8px] flex items-center justify-center border border-bg-300 text-text-300",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: "linear-gradient(to bottom, var(--color-bg-0), var(--color-bg-200))",
      }}
    >
      {createElement(pluginGlyph(`${name} ${hints}`), { style: { width: size * 0.48, height: size * 0.48 }, strokeWidth: 1.5 })}
    </span>
  );
}

/** A connector's logo on a white tile, as in the directory; the first letter when it has none. */
export function ConnectorLogo({
  entry,
  size = 40,
  className,
}: {
  entry: { name: string; logo?: string; color?: string };
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const color = entry.color && entry.color.toLowerCase() !== "#e5e5e5" ? entry.color : "#6b7280";
  const showLogo = !!entry.logo && !failed;
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 flex items-center justify-center overflow-hidden border border-black/10 bg-white font-semibold",
        size >= 32 ? "rounded-[8px]" : "rounded-[5px]",
        className,
      )}
      style={{ width: size, height: size, color, fontSize: size * 0.42 }}
    >
      {showLogo ? (
        <img
          src={entry.logo}
          alt=""
          draggable={false}
          className="text-neutral-900"
          style={{ width: size * 0.6, height: size * 0.6, objectFit: "contain" }}
          onError={() => setFailed(true)}
        />
      ) : (
        entry.name.charAt(0).toUpperCase()
      )}
    </span>
  );
}
