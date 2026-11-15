import { invoke } from "@/lib/ipc";
import { rememberClaudeMemoryDir } from "./claudeMemoryDir";
import { userNyxsDir } from "./paths";
import { loadPluginRawSkills } from "./plugins/pluginSkills";
import { VIDEO_SKILL } from "./video/videoSkill";
import { MODS_SKILL } from "./mods/skill/modsSkill";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface SkillDef {
  name: string;
  dir: string;
  source: "project" | "user" | "builtin" | "plugin";
  description: string;
  whenToUse?: string;
  body: string;
}

interface RawSkill {
  name: string;
  dir: string;
  content: string;
  source: string;
}

const MAX_LISTING_DESC_CHARS = 250;

function parseFrontmatter(content: string): {
  fm: Record<string, string>;
  body: string;
} {
  const normalized = content.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { fm: {}, body: normalized };

  const fm: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[m[1].toLowerCase()] = value;
  }
  return { fm, body: match[2] };
}

function fallbackDescription(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t;
  }
  return "Skill with no description.";
}

async function readRawFile(path: string): Promise<string> {
  try {
    const out = await invoke<string | null>("agent_read_text", { path });
    return (out ?? "").replace(/\r\n/g, "\n").trimEnd();
  } catch {
    return "";
  }
}

/** A memory file as the context panel lists it, with the size it adds to the prompt. */
export interface MemoryFileInfo {
  name: string;
  chars: number;
}

export interface ProjectMemoryBundle {
  text: string;
  files: MemoryFileInfo[];
}

/** The base memory file's name, picked in the same order as the backend. */
async function baseMemoryPath(root: string, nyxsOnly: boolean): Promise<string | null> {
  const candidates = nyxsOnly ? ["NYXS.md", ".nyxs/NYXS.md"] : ["NYXS.md", ".nyxs/NYXS.md", "AGENTS.md", "CLAUDE.md"];
  for (const name of candidates) {
    const content = await readRawFile(`${root}/${name}`);
    if (content.trim()) return `${root}/${name}`;
  }
  return null;
}

/**
 * NYXS.md (or what stands in for it), the project's rules, NYXS.local.md and ~/.nyxs/NYXS.md,
 * with each file's size so the context panel can list them.
 * `nyxsOnly` leaves out the AGENTS.md / CLAUDE.md that stand in for a missing NYXS.md, for an
 * agent that loads those itself (Claude Code).
 */
export async function loadProjectMemoryBundle(
  workspace: string | null,
  { nyxsOnly = false } = {},
): Promise<ProjectMemoryBundle> {
  if (!isTauri || !workspace) return { text: "", files: [] };
  const root = workspace.replace(/[\\/]+$/, "");
  const parts: string[] = [];
  const files: MemoryFileInfo[] = [];

  try {
    const base = nyxsOnly
      ? (await readRawFile(`${root}/NYXS.md`)) || (await readRawFile(`${root}/.nyxs/NYXS.md`))
      : await invoke<string>("agent_read_memory", { workspace });
    if (base.trim()) {
      const content = base.trim();
      parts.push(content);
      const name = await baseMemoryPath(root, nyxsOnly);
      if (name) files.push({ name, chars: content.length });
    }
  } catch {
    /* no base memory file */
  }

  try {
    const entries = await invoke<string[]>("agent_list_dir", { path: `${root}/.nyxs/rules` });
    const ruleFiles = entries
      .filter((name) => !name.endsWith("/") && name.toLowerCase().endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
    for (const name of ruleFiles) {
      const content = await readRawFile(`${root}/.nyxs/rules/${name}`);
      if (content.trim()) {
        const part = `## Rule: ${name}\n\n${content.trim()}`;
        parts.push(part);
        files.push({ name: `${root}/.nyxs/rules/${name}`, chars: part.length });
      }
    }
  } catch {
    /* no .nyxs/rules directory */
  }

  const local = await readRawFile(`${root}/NYXS.local.md`);
  if (local.trim()) {
    const part = `## Local overrides (NYXS.local.md)\n\n${local.trim()}`;
    parts.push(part);
    files.push({ name: `${root}/NYXS.local.md`, chars: part.length });
  }

  try {
    const global = await readRawFile(`${await userNyxsDir()}/NYXS.md`);
    if (global.trim()) {
      const part = `## Personal instructions (~/.nyxs/NYXS.md)\n\n${global.trim()}`;
      parts.unshift(part);
      files.unshift({ name: "~/.nyxs/NYXS.md", chars: part.length });
    }
  } catch {
    /* no home directory */
  }

  return { text: parts.join("\n\n---\n\n"), files };
}

export async function loadProjectMemory(workspace: string | null, options: { nyxsOnly?: boolean } = {}): Promise<string> {
  return (await loadProjectMemoryBundle(workspace, options)).text;
}

/** The MEMORY.md index Claude Code keeps for this project (~/.claude/projects/<slug>/memory),
 *  with its links made absolute so the model can open each memory with Read. */
export async function loadClaudeMemory(workspace: string | null): Promise<string> {
  if (!isTauri || !workspace) return "";
  try {
    const mem = await invoke<{ dir: string; index: string } | null>("agent_read_claude_memory", { workspace });
    if (!mem?.index.trim()) return "";
    rememberClaudeMemoryDir(workspace, mem.dir);
    const dir = mem.dir.replace(/\\/g, "/").replace(/\/+$/, "");
    const index = mem.index
      .replace(/\r\n/g, "\n")
      .replace(/\]\((?![a-z]+:|\/)([^)\s]+\.md)\)/gi, (_m, file: string) => `](${dir}/${file})`)
      .trim();
    return `Folder: \`${dir}\`\n\n${index}`;
  } catch {
    return "";
  }
}

export const BUILTIN_ORCHESTRATION_SKILLS: SkillDef[] = [
  {
    name: "review",
    dir: "",
    source: "builtin",
    description:
      "Review the current code changes for bugs and quality by fanning out parallel sub-agents (one per review lens), then synthesize one deduplicated report.",
    whenToUse:
      "When the user asks to review the current changes/diff/PR, or to check recent code for bugs, regressions, or quality problems before committing.",
    body: `Run a thorough, PARALLEL review of the CURRENT changes (the working-tree diff, unless the user names specific files). This skill is review-only — do NOT edit files here.

## Step 1 — Scope
Determine what changed: run \`git diff --stat\` and \`git diff\` via Bash (or read the files the user named). If nothing changed, say so and stop.

## Step 2 — Fan out (parallel)
Use the Agent tool to launch THREE sub-agents IN PARALLEL — emit the Agent calls together in a single message so they run concurrently. Give each the list of changed files plus its focus:
1. Correctness & bugs — logic errors, missed edge cases, error handling, race conditions, broken contracts, regressions.
2. Reuse & simplification — duplicated logic, dead code, needless complexity, existing helpers that should be reused, clearer equivalents.
3. Security & robustness — injection, unsafe input handling, leaked secrets, path/permission issues, resource leaks.
Instruct each sub-agent to READ the relevant code (read-only — it must not modify anything) and return findings as a list: \`severity (high/med/low) · file:line · what · why · suggested fix\`. Report only real, concrete issues — no style nits, no speculation — and say "no issues found" when clean.

## Step 3 — Synthesize
Merge the three reports: deduplicate overlapping findings, drop anything not grounded in the actual diff, sort by severity (high first).

## Step 4 — Report as a review card
The app draws the report as an interactive card (open each finding in the diff, fix one, apply all), so write it as ONE fenced block with the language \`nyxs-review\` holding JSON, and nothing else after a one-sentence verdict:

\`\`\`nyxs-review
{"verdict": "Fix these first", "findings": [{"severity": "high", "file": "src/lib/a.ts", "line": 42, "title": "Null user crashes the save", "detail": "What is wrong and why, in one or two sentences.", "fix": "The concrete change to make."}]}
\`\`\`

- \`severity\` is "high", "med" or "low"; \`file\` is relative to the project folder; \`line\` is the line in the CURRENT file (omit it when the finding isn't about one line).
- Write \`verdict\`, \`title\`, \`detail\` and \`fix\` in the user's language. Keep \`title\` short (under 80 characters).
- No findings: \`{"verdict": "...", "findings": []}\`.
- The JSON must be valid: escape quotes and newlines inside strings.
Make no edits as part of this review: the card lets the user ask for fixes.`,
  },
  {
    name: "simplify",
    dir: "",
    source: "builtin",
    description:
      "Clean up the current code changes for reuse, simplification, and efficiency, then apply the safe fixes. Quality only — it does not hunt for bugs.",
    whenToUse:
      "When the user asks to simplify, refactor, tidy, or reduce duplication in the recent changes.",
    body: `Improve the QUALITY of the CURRENT changes (working-tree diff, unless the user names files) — reuse, simplification, efficiency, clarity — WITHOUT changing behavior.

## Step 1 — Scope
Identify what changed (\`git diff\` via Bash, or the named files). If nothing changed, stop and say so.

## Step 2 — Find cleanups
Look for: duplicated logic that could reuse an existing helper, dead or unreachable code, needlessly complex expressions, redundant work inside loops, and unclear names. For a large diff you may fan out sub-agents via the Agent tool (one per area) to gather suggestions in parallel; for a small diff, do it directly.

## Step 3 — Apply
Apply ONLY safe, behavior-preserving cleanups with Edit/MultiEdit. Skip anything risky or behavior-changing — flag those for the user instead. After each edit the project's checker runs automatically; fix anything it reports.

## Step 4 — Report
Summarize what you changed and why, and list anything you intentionally left untouched (with the reason).`,
  },
  VIDEO_SKILL,
  MODS_SKILL,
];

export async function loadSkills(workspace: string | null): Promise<SkillDef[]> {
  if (!isTauri) return [];
  let raw: RawSkill[];
  try {
    raw = await invoke<RawSkill[]>("agent_list_skills", { workspace });
  } catch {
    return [];
  }

  const skills = raw.map((r) => {
    const { fm, body } = parseFrontmatter(r.content);
    const description = fm.description || fallbackDescription(body);
    const whenToUse = fm.when_to_use || fm["when-to-use"] || undefined;
    return {
      name: r.name,
      dir: r.dir,
      source: r.source === "user" ? "user" : "project",
      description,
      whenToUse,
      body: body.trim(),
    } satisfies SkillDef;
  });

  const taken = new Set(skills.map((s) => s.name));
  let pluginSkills: SkillDef[] = [];
  try {
    const rawPlugin = await loadPluginRawSkills();
    pluginSkills = rawPlugin
      .filter((r) => !taken.has(r.name))
      .map((r) => {
        const { fm, body } = parseFrontmatter(r.content);
        return {
          name: r.name,
          dir: r.dir,
          source: "plugin",
          description: fm.description || fallbackDescription(body),
          whenToUse: fm.when_to_use || fm["when-to-use"] || undefined,
          body: body.trim(),
        } satisfies SkillDef;
      });
  } catch {
    // Plugin system unavailable or errored — fall back to local skills only.
  }

  const all = [...skills, ...pluginSkills];
  const present = new Set(all.map((s) => s.name.toLowerCase()));
  const builtins = BUILTIN_ORCHESTRATION_SKILLS.filter((s) => !present.has(s.name.toLowerCase()));
  return [...all, ...builtins];
}

export function buildSkillsListing(skills: SkillDef[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => {
    let desc = s.whenToUse ? `${s.description} - ${s.whenToUse}` : s.description;
    if (desc.length > MAX_LISTING_DESC_CHARS) {
      desc = desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + "…";
    }
    return `- ${s.name}: ${desc}`;
  });
  return lines.join("\n");
}

export function resolveSkillContent(skill: SkillDef, args: string): string {
  const skillDir = skill.dir.replace(/\\/g, "/");
  let content = skillDir ? `Base directory for this skill: ${skillDir}\n\n${skill.body}` : skill.body;
  content = content.replace(/\$\{(?:CLAUDE_SKILL_DIR|SKILL_DIR)\}/g, skillDir);

  const argList = args.trim() ? args.trim().split(/\s+/) : [];
  content = content.replace(/\$ARGUMENTS\b/g, args.trim());
  content = content.replace(/\$(\d+)/g, (_, n) => argList[Number(n) - 1] ?? "");
  return content;
}
