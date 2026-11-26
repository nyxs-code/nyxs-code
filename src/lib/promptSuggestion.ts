import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AUTH_BASE, getToken } from "./auth";
import { callModel } from "./callModel";
import { chatUsedGoogleData } from "./connectorsMcp";
import { buildModel, pickHelperModel } from "./modelClient";
import { getModel, runsInCli } from "./models";
import type { Settings } from "./settings";
import { getMergedSnapshot } from "./settingsRuntime";

const http = tauriFetch as unknown as typeof fetch;

export interface SuggestionTurn {
  role: "user" | "assistant";
  content: string;
  /** The app closed while this reply ran: it isn't finished, so there's nothing to follow up. */
  cutOff?: unknown;
}

const MAX_TURNS = 8;
const LAST_REPLY_CHARS = 6000;
const EARLIER_REPLY_CHARS = 1500;
const USER_CHARS = 1000;
const MAX_CHARS = 60;
const MAX_WORDS = 12;
const MAX_SUGGESTION_CHARS = 100;

// Claude Code's own instructions for its prompt suggestions (CLI 2.1.332), with the two mistakes
// Nyxs' guesses made spelled out: options that don't exist and steps the assistant already took.
const SUGGEST_SYSTEM = `[SUGGESTION MODE: Suggest what the user might naturally type next to their AI coding assistant.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Assistant offers options → suggest the one the user would likely pick, based on conversation
Assistant asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Something the assistant already did: its tool calls are listed as [tool ...] lines
- An option, file or command the conversation doesn't mention (with two options offered, there is no "option 3")
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate, including any sensitive topic (security incidents, credentials, harm, private data).

Format: 2-12 words, in the language the user writes in, matching the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation. To stay silent, reply NONE.`;

/** A reply as the guesser reads it: its text, with each tool call it made as a short line (so a
 *  pull request it already opened isn't suggested again) and without its reasoning. */
export function replyText(content: string): string {
  return content
    .replace(/⟦REASONING⟧[\s\S]*?⟦\/REASONING⟧/g, "")
    .replace(/⟦TOOL⟧[^⟦]*⟦SEP⟧([^⟦]*)⟦SEP⟧([^⟦]*)⟦\/TOOL⟧/g, (_, name: string, detail: string) =>
      `[tool ${name.trim()}${detail.trim() ? `: ${detail.trim().slice(0, 160)}` : ""}]`)
    .replace(/⟦TOOLEND⟧[^⟦]*⟦SEP⟧err⟦SEP⟧([\s\S]*?)⟦\/TOOLEND⟧/g, (_, error: string) => `[tool failed: ${error.trim().slice(0, 160)}]`)
    .replace(/⟦TOOLEND⟧[\s\S]*?⟦\/TOOLEND⟧/g, "")
    .replace(/⟦(?:TODO|PLAN)⟧/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Keeps the end of a long reply: that's where its offers and questions are. */
function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** The user's first message and the last turns, cut down so the guess stays cheap whatever the
 *  chat's length. The last reply goes in nearly whole: the options it offers decide the guess. */
function transcript(turns: SuggestionTurn[]): string {
  const said = turns
    .map((t) => ({ role: t.role, text: t.role === "assistant" ? replyText(t.content) : t.content.trim() }))
    .filter((t) => t.text);
  const recent = said.slice(-MAX_TURNS);
  const first = said.find((t) => t.role === "user");
  const shown = first && !recent.includes(first) ? [first, ...recent] : recent;
  return shown
    .map((t, i) => {
      if (t.role === "user") return `[User]: ${t.text.slice(0, USER_CHARS)}`;
      const last = i === shown.length - 1;
      return `[Assistant]: ${tail(t.text, last ? LAST_REPLY_CHARS : EARLIER_REPLY_CHARS)}`;
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

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** One-word messages a user does send. */
const SHORT_REPLIES = new Set([
  "yes", "yeah", "yep", "yea", "yup", "sure", "ok", "okay", "push", "commit", "deploy", "stop", "continue", "check", "exit", "quit", "no",
  "sí", "si", "vale", "dale", "venga", "adelante", "hazlo", "continúa", "continua", "sigue", "súbelo", "subelo", "para",
]);

/** Claude Code's checks on a guess (CLI 2.1.332), with the Spanish forms Nyxs' users write: a
 *  guess the user wouldn't send as it stands is dropped rather than shown. */
function unwanted(text: string): boolean {
  const lower = text.toLowerCase();
  const plain = lower.replace(/<[^<>]*>|[^\p{L}\p{N}\s()[\]]/gu, " ").replace(/\s+/g, " ").trim();
  const n = words(text);
  return (
    /^(done|listo|hecho)$/.test(plain) ||
    /^(nothing found|nothing to suggest|no suggestion|sin sugerencia|ninguna|nada que sugerir)/.test(plain) ||
    /\bsilence is\b|\bstay(s|ing)? silent\b|^\W*(silence|silencio)\W*$/u.test(plain) ||
    !plain ||
    /^(\(.*\)|\[.*\])$/.test(plain) ||
    /^(api error:|prompt is too long|request timed out|invalid api key)/.test(lower) ||
    /^[\p{L}\p{N}_]+:\s/u.test(text) ||
    (n < 2 && !text.startsWith("/") && !SHORT_REPLIES.has(plain)) ||
    n > MAX_WORDS ||
    text.length >= MAX_SUGGESTION_CHARS ||
    /[.!?]\s+[A-ZÁÉÍÓÚÑ¿¡]/.test(text) ||
    /[\n*]/.test(text) ||
    /thanks|thank you|looks good|sounds good|that works|that worked|that's all|\bnice\b|\bgreat\b|perfect|makes sense|awesome|excellent/.test(lower) ||
    /\b(gracias|perfecto|genial|excelente|buen trabajo|se ve bien|queda bien|tiene sentido)\b/u.test(lower) ||
    /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)\b/.test(lower) ||
    // Not "puedes…": "Puedes añadir los tests" is how many users ask.
    /^(déjame|voy a|he hecho|aquí (está|tienes)|deberías|claro,|por supuesto|esto es|eso es)(?=[\s,]|$)/u.test(lower) ||
    // A request, never a question.
    /[?？]$|^¿/.test(text)
  );
}

/** The whole guessed message, which is what Tab puts in the box; "" when there's none to show. */
export function cleanSuggestion(raw: string): string {
  const line = raw
    .replace(/⟦(TOOL|TOOLEND|REASONING)⟧[\s\S]*?⟦\/\1⟧|⟦(?:TODO|PLAN)⟧/g, "")
    .trim()
    .replace(/^<(suggestion|response|output|answer|result)>([\s\S]*)<\/\1>$/i, "$2")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";
  const text = line
    .replace(/^\s*(suggested\s+(response|reply|input|prompt)|suggestion|sugerencia|response|reply|answer|output|result)\s*[:：]\s*/i, "")
    .replace(/^["'“”«»`]+|["'“”«»`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^none\.?$/i.test(text) || unwanted(text)) return "";
  return text;
}

/** The one-line hint shown as the placeholder: the box is a single row, so a long guess is cut
 *  here for display only. */
export function previewSuggestion(text: string): string {
  return cutAtWord(text, MAX_CHARS);
}

/** Whether a guess makes sense after this conversation, as Claude Code decides: not after a single
 *  plain answer (nothing to go on yet), nor after a reply that didn't finish. */
function worthGuessing(turns: SuggestionTurn[]): boolean {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant" || last.cutOff || !last.content.trim()) return false;
  const replies = turns.filter((t) => t.role === "assistant").length;
  return replies >= 2 || last.content.includes("⟦TOOL⟧");
}

/** Asks the Nyxs backend for the guess, the way chat titles are named. "" when it can't be asked
 *  (not signed in) or fails: there's just no suggestion this time. */
async function suggestFromBackend(prompt: string, signal?: AbortSignal): Promise<string> {
  const token = await getToken();
  if (!token) return "";
  try {
    const res = await http(`${AUTH_BASE}/api/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      // The backend keeps 2000 characters of `system` and 16000 of `prompt`, and joins the two:
      // the instructions go in the prompt so none of them is cut.
      body: JSON.stringify({ system: "", prompt: `${SUGGEST_SYSTEM}\n\n${prompt}` }),
      signal,
    });
    if (!res.ok) return "";
    return ((await res.json()) as { suggestion?: string }).suggestion ?? "";
  } catch {
    return "";
  }
}

/** Guesses the user's next message for the chat box, for any provider. Claude Code chats get
 *  theirs from the CLI itself (onClaudeCodeSuggestion); API models ask a small model of their
 *  provider (or the helper model the user picked); other CLI agents ask the user's API helper
 *  model or else Nyxs' backend, since a run of their CLI per guess would spend the user's plan. */
export async function suggestNextPrompt(
  modelId: string,
  settings: Settings,
  turns: SuggestionTurn[],
  signal?: AbortSignal,
): Promise<string> {
  // Both helpers are models the user didn't pick for this chat, which Google doesn't allow for
  // what Gmail or Calendar returned.
  if (chatUsedGoogleData(turns.map((t) => t.content))) return "";
  const model = getModel(modelId, settings);
  if (!model || model.provider === "claude-code") return "";
  if (!worthGuessing(turns)) return "";
  const conversation = transcript(turns);
  if (!conversation) return "";
  const prompt = `<conversation>\n${conversation}\n</conversation>\n\nThe user's next message:`;

  const helper = pickHelperModel(model, settings, (getMergedSnapshot() as { helperModel?: string }).helperModel);
  if (runsInCli(helper.provider)) return cleanSuggestion(await suggestFromBackend(prompt, signal));
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
