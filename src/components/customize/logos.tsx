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

/** GitHub's mark, next to a plugin's repository (lucide no longer ships brand icons). */
export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

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
