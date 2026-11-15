import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AUTH_BASE, getToken } from "./auth";
import { privacySettings } from "./privacySettings";
import { getMergedSnapshot } from "./settingsRuntime";
import type { ProviderId } from "./models";

const http = tauriFetch as unknown as typeof fetch;

const TRAIL = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "para",
  "con", "y", "o", "en", "a", "al", "que", "por", "su", "mi", "tu", "the", "of",
  "for", "to", "and", "or", "in", "on", "with", "an", "my",
]);
function dropTrailingStop(s: string): string {
  const w = s.split(" ");
  while (w.length > 1 && TRAIL.has(w[w.length - 1].toLowerCase())) w.pop();
  return w.join(" ");
}

export function clampTitle(s: string, max = 35): string {
  s = (s || "")
    .replace(/^["'“”'«»]+|["'“”'«»]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(t[ií]tulo|title):\s*/i, "")
    .replace(/[.…]+$/, "");
  if (s.length <= max) return dropTrailingStop(s);
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return dropTrailingStop((sp > max * 0.5 ? cut.slice(0, sp) : cut).trimEnd());
}

/** Who names new chats (Settings › General): Nyxs' service, Codex, Claude Haiku, or nobody. */
export type TitleGenerator = "auto" | "codex" | "claude-haiku" | "off";
export const TITLE_GENERATORS: TitleGenerator[] = ["auto", "codex", "claude-haiku", "off"];

export function resolveTitleGenerator(v: unknown): TitleGenerator {
  return TITLE_GENERATORS.includes(v as TitleGenerator) ? (v as TitleGenerator) : "auto";
}

async function titleGenerator(): Promise<TitleGenerator> {
  try {
    return resolveTitleGenerator((getMergedSnapshot() as { titleGeneration?: unknown }).titleGeneration);
  } catch {
    // Settings not read yet: a title is never lost over it.
    return "auto";
  }
}

const TITLE_PROMPT = (message: string) =>
  `Write a title for a chat with an AI coding assistant that starts with the message below.
- At most 6 words, in the language of the message.
- Name the task or problem, specifically (a feature, a file, an error).
- Reply with the title alone: no quotes, no prefix, no final period.

<message>
${message.slice(0, 2000)}
</message>`;

/** Asks Nyxs' service. Null when it can't be asked (not signed in, unreachable). */
async function titleFromService(message: string, assistant?: string): Promise<string | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await http(`${AUTH_BASE}/api/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, assistant }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string };
    return clampTitle(data.title || "", 35) || null;
  } catch {
    return null;
  }
}

/** One short run of Claude Code on Haiku, on the user's own Claude plan. */
async function titleFromClaude(message: string): Promise<string> {
  const { CLAUDE_CODE_MODELS, streamClaudeCode } = await import("./claudeCode");
  const haiku = CLAUDE_CODE_MODELS.find((m) => m.apiModel === "haiku") ?? CLAUDE_CODE_MODELS[0];
  let text = "";
  await streamClaudeCode({
    model: { ...haiku, effortLevels: [] },
    history: [{ role: "user", content: TITLE_PROMPT(message) }],
    workspace: null,
    planMode: false,
    effort: "low",
    ephemeral: true,
    onChunk: (delta) => {
      text += delta;
    },
  });
  return clampTitle(firstLine(text), 35);
}

/** One short run of Codex, on its smallest model the user has, else its default. */
async function titleFromCodex(message: string): Promise<string> {
  const [{ streamCodexCli }, { loadSettings }, { AGENT_CLI_DEFAULT_MODEL }] = await Promise.all([import("./codexCli"), import("./settings"), import("./agentCli")]);
  const models = loadSettings()["codex-cli"]?.models ?? [];
  const model = models.find((m) => /mini/i.test(m.apiModel)) ?? {
    id: `codex-cli:${AGENT_CLI_DEFAULT_MODEL}`,
    apiModel: AGENT_CLI_DEFAULT_MODEL,
    name: "Codex",
    description: "Codex",
    provider: "codex-cli" as const,
  };
  let text = "";
  await streamCodexCli({
    model,
    history: [{ role: "user", content: TITLE_PROMPT(message) }],
    workspace: null,
    planMode: true,
    effort: "low",
    ephemeral: true,
    onChunk: (delta) => {
      text += delta;
    },
  });
  return clampTitle(firstLine(text.replace(/⟦(TOOL|TOOLEND|REASONING)⟧[\s\S]*?⟦\/\1⟧|⟦(?:TODO|PLAN)⟧/g, "")), 35);
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/** A title by one generator; throws when it fails, so Settings' test can say why. */
export async function titleBy(generator: Exclude<TitleGenerator, "auto" | "off">, message: string): Promise<string> {
  const title = generator === "codex" ? await titleFromCodex(message) : await titleFromClaude(message);
  if (!title) throw new Error("empty answer");
  return title;
}

/**
 * Titles a new chat in the language of its first message (not the app's). "auto" asks Nyxs'
 * service, and where it can't be asked, the CLI the chat itself runs on (Haiku for Claude Code,
 * Codex for Codex); with chat titles off in Settings › Privacy it sends the message nowhere.
 * Codex and Claude Haiku are the user's own pick and always run. Any failure falls back to the
 * message itself.
 */
export async function generateChatTitle(message: string, assistant?: string, provider?: ProviderId): Promise<string> {
  const fallback = clampTitle(message, 35);
  const generator = await titleGenerator();
  if (generator === "off") return fallback;
  try {
    if (generator === "codex" || generator === "claude-haiku") return await titleBy(generator, message);
    if (!(await privacySettings()).chatTitles) return fallback;
    const fromService = await titleFromService(message, assistant);
    if (fromService) return fromService;
    if (provider === "claude-code") return await titleBy("claude-haiku", message);
    if (provider === "codex-cli") return await titleBy("codex", message);
  } catch {
    // The CLI isn't installed, signed in or within its plan: the message names the chat.
  }
  return fallback;
}

/**
 * Settings' "Test": the title a generator gives `sample`. "auto" shows what Nyxs' service
 * answers, or the message itself where it can't be asked; Codex and Claude Haiku throw their
 * failure so it can be shown.
 */
export async function testTitle(generator: TitleGenerator, sample: string): Promise<string> {
  if (generator === "codex" || generator === "claude-haiku") return titleBy(generator, sample);
  if (generator === "auto" && (await privacySettings()).chatTitles) {
    const fromService = await titleFromService(sample);
    if (fromService) return fromService;
  }
  return clampTitle(sample, 35);
}
