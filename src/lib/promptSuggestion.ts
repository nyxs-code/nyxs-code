import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AUTH_BASE, getToken } from "./auth";
import { callModel } from "./callModel";
import { CLAUDE_CODE_MODELS, claudePlanRefused, streamClaudeCode } from "./claudeCode";
import { chatUsedGoogleData } from "./connectorsMcp";
import { buildModel, pickHelperModel } from "./modelClient";
import { getModel, PROVIDERS, type ModelInfo } from "./models";
import type { Settings } from "./settings";
import { getMergedSnapshot } from "./settingsRuntime";

const http = tauriFetch as unknown as typeof fetch;

export interface SuggestionTurn {
  role: "user" | "assistant";
  content: string;
}

const MAX_TURNS = 6;
const MAX_CHARS = 60;
const MAX_SUGGESTION_CHARS = 300;
// The backend keeps only the first 2000 characters of these instructions.
const SUGGEST_SYSTEM = `You predict the next message a user will type to their AI coding assistant, so they can send it with one key.
Write the instruction the user would most likely give next: the obvious next step of the work, as a direct request to the assistant.
Good: "Run the tests", "Commit and push", "Apply the same fix to the other dialogs", "Yes, go ahead".
Rules:
- A request or an answer, never a question. Don't ask the assistant how it went, what it thinks or what else there is.
- If the assistant's last reply ends by asking the user something or offering options, answer it ("Yes, do it", "The second option").
- Make it specific to this conversation: name the file, feature or step involved. Never generic ("Continue", "Thanks", "Looks good", "Explain more").
- Don't repeat something already done or already asked for.
- Write it in the language the user writes in, from the user's point of view.
- At most 12 words, one line. No quotes, no explanations, no prefixes.
- If no next step is clear, answer exactly NONE.`;

// Claude Code models only run through the CLI; Haiku keeps the extra turn cheap and quick.
const CLAUDE_CODE_HELPER: ModelInfo = {
  ...(CLAUDE_CODE_MODELS.find((m) => m.apiModel === "haiku") ?? CLAUDE_CODE_MODELS[0]),
  effortLevels: [],
};

/** The last turns, cut down so the suggestion stays cheap whatever the chat's length. */
function transcript(turns: SuggestionTurn[]): string {
  return turns
    .filter((t) => t.content.trim())
    .slice(-MAX_TURNS)
    .map((t) => {
      const text = t.content.trim();
      const cut = t.role === "assistant" ? (text.length > 2000 ? `…${text.slice(-2000)}` : text) : text.slice(0, 1000);
      return `[${t.role === "user" ? "User" : "Assistant"}]: ${cut}`;
    })
    .join("\n\n");
}

/** Cuts at a word and marks the cut with "…"; returns the text as is when it already fits. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** The whole guessed message, which is what Tab puts in the box. Only a runaway answer is cut. */
export function cleanSuggestion(raw: string): string {
  const line = raw
    .replace(/⟦(TOOL|TOOLEND|REASONING)⟧[\s\S]*?⟦\/\1⟧|⟦(?:TODO|PLAN)⟧/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";
  const text = line.replace(/^["'“”«»`]+|["'“”«»`]+$/g, "").replace(/\s+/g, " ").trim();
  if (!text || /^none\.?$/i.test(text)) return "";
  // Small helper models still slip in a question now and then; a guess the user would send is a
  // request, so a question is dropped rather than shown.
  if (/[?？]$|^[¿]/.test(text)) return "";
  return cutAtWord(text, MAX_SUGGESTION_CHARS);
}

/** The one-line hint shown as the placeholder: the box is a single row, so a long guess is cut
 *  here for display only. */
export function previewSuggestion(text: string): string {
  return cutAtWord(text, MAX_CHARS);
}

/** Asks the Nyxs backend for the guess, the way chat titles are named: a CLI process per reply
 *  took seconds, CPU and the user's plan. Null only when the backend can't be asked at all (not
 *  signed in, or a backend without the route yet), so the caller falls back to the CLI; any
 *  other failure is just no suggestion this time. */
async function suggestFromBackend(prompt: string, signal?: AbortSignal): Promise<string | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await http(`${AUTH_BASE}/api/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ system: SUGGEST_SYSTEM, prompt }),
      signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) return "";
    const data = (await res.json()) as { suggestion?: string };
    return data.suggestion ?? "";
  } catch {
    return "";
  }
}

/** Guesses the user's next message for the chat box, with a small model of the chat's provider. */
export async function suggestNextPrompt(
  modelId: string,
  settings: Settings,
  turns: SuggestionTurn[],
  signal?: AbortSignal,
): Promise<string> {
  // Every path below sends the chat to a model the user didn't pick for it (Nyxs' service, or a
  // helper), which Google doesn't allow for what Gmail or Calendar returned.
  if (chatUsedGoogleData(turns.map((t) => t.content))) return "";
  const model = getModel(modelId, settings);
  const conversation = transcript(turns);
  if (!model || !conversation) return "";
  const prompt = `<conversation>\n${conversation}\n</conversation>\n\nThe user's next message:`;

  if (model.provider === "claude-code") {
    // With the plan out of room the user can't send the guess anyway.
    if (claudePlanRefused()) return "";
    const fromBackend = await suggestFromBackend(prompt, signal);
    if (fromBackend !== null) return cleanSuggestion(fromBackend);
    let text = "";
    await streamClaudeCode({
      model: CLAUDE_CODE_HELPER,
      history: [{ role: "user", content: `${SUGGEST_SYSTEM}\n\n${prompt}` }],
      workspace: null,
      signal,
      planMode: false,
      effort: "low",
      ephemeral: true,
      onChunk: (delta) => {
        text += delta;
      },
    });
    return cleanSuggestion(text);
  }
  // Each guess would start another run of the user's CLI, against their own plan.
  if (PROVIDERS[model.provider]?.kind === "agent-cli") return "";

  const helper = pickHelperModel(model, settings, (getMergedSnapshot() as { helperModel?: string }).helperModel);
  const result = callModel({
    model: buildModel(helper, settings),
    system: SUGGEST_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    // Room for models that think before answering; the answer itself is a dozen words.
    maxOutputTokens: 400,
    maxRetries: 1,
    abortSignal: signal,
  });
  let text = "";
  for await (const delta of result.textStream) text += delta;
  return cleanSuggestion(text);
}
