import { useEffect, useState } from "react";

/** What the mascot shows. Each one is a clip or a pose in `src/assets/mascot/`. */
export type MascotMood = "intro" | "wave" | "rest" | "think" | "search" | "code" | "celebrate" | "surprised" | "sad" | "shy" | "sleep";

/** After this long with nothing happening, the mascot falls asleep. */
const SLEEP_AFTER_MS = 3 * 60_000;
/** How long it reacts to what the user just wrote, before it starts thinking. */
const REACT_MS = 2600;
/** How long it shows that the turn ended on an error. */
const TURN_END_MS = 4000;

const plain = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Order matters: "no funciona" is frustration, not "funciona".
const FRUSTRATED = /\b(no funciona|no sirve|no anda|sigue (sin|igual|fallando|mal)|otra vez|de nuevo mal|esta roto|falla|fallo|wtf|ugh|por que no|not working|doesn'?t work|still broken|broken|again\?)\b|!!|\?\?/;
const SORRY = /\b(perdon|perdona|disculpa|ups|oops|me equivoque|lo siento|sorry|my bad)\b/;
const GRATEFUL = /\b(gracias|genial|perfecto|excelente|increible|buenisimo|me encanta|bien hecho|funciona|funciono|crack|thanks|thank you|great|awesome|perfect|love it|nice)\b|🎉|❤|👍|🙌/;

/** How the mascot reacts to a message from the user, or null to go straight to thinking. */
export function moodOfMessage(text: string): MascotMood | null {
  const t = plain(text);
  if (FRUSTRATED.test(t)) return "sad";
  if (SORRY.test(t)) return "shy";
  if (GRATEFUL.test(t)) return "celebrate";
  return null;
}

/** A reply that ended on an error carries the "⚠️ Error:" line the turn appends. */
const endedOnError = (content: string) => /⚠️ Error:/.test(content.slice(-2000));

const SEARCH_TOOLS = /^(Read|Grep|Glob|LS|WebSearch|WebFetch|ToolSearch|Lsp\w*)$/;
const CODE_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell|ApplyPatch)$/;

/** What the agent is doing by its latest tool call: reading/searching, or writing/running. */
export function moodOfTool(name: string | undefined): MascotMood | null {
  if (!name) return null;
  if (SEARCH_TOOLS.test(name)) return "search";
  if (CODE_TOOLS.test(name)) return "code";
  return null;
}

interface MoodMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Tool calls in the order they ran. */
  toolData?: Record<string, { name: string }>;
}

function latestTool(m: MoodMessage | undefined): string | undefined {
  if (m?.role !== "assistant" || !m.toolData) return undefined;
  const calls = Object.values(m.toolData);
  return calls[calls.length - 1]?.name;
}

/**
 * The mascot's mood for a chat: it reacts to what the user writes, searches, codes or thinks
 * while the agent works (by its latest tool), waves when it needs the user, shows a turn that
 * ended on an error and falls asleep when nothing happens.
 */
export function useMascotMood({ messages, busy, waiting }: { messages: readonly MoodMessage[]; busy: boolean; waiting: boolean }): MascotMood {
  const [flash, setFlash] = useState<{ mood: MascotMood; ms: number } | null>(null);

  let lastUser: MoodMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUser = messages[i]; break; }
  }
  const last = messages[messages.length - 1];

  // Reactions are worked out while rendering, when what they react to changes. Only messages
  // sent while the chat is open count: opening an old chat doesn't replay a reaction.
  const [seenUser, setSeenUser] = useState(lastUser?.id);
  if (lastUser && lastUser.id !== seenUser) {
    setSeenUser(lastUser.id);
    const mood = moodOfMessage(lastUser.content);
    if (mood) setFlash({ mood, ms: REACT_MS });
  }

  const [wasBusy, setWasBusy] = useState(busy);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    // A turn that ends well goes straight back to rest (the user didn't want a thumbs-up after
    // every reply); only an error shows on the way out.
    if (!busy && last?.role === "assistant" && endedOnError(last.content)) setFlash({ mood: "surprised", ms: TURN_END_MS });
  }

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), flash.ms);
    return () => clearTimeout(t);
  }, [flash]);

  // Asleep while nothing has happened since the timer that put it to sleep.
  const activity = `${messages.length}:${busy}:${waiting}`;
  const [sleptAt, setSleptAt] = useState<string | null>(null);
  useEffect(() => {
    if (busy || waiting) return;
    const t = setTimeout(() => setSleptAt(activity), SLEEP_AFTER_MS);
    return () => clearTimeout(t);
  }, [activity, busy, waiting]);
  const asleep = sleptAt === activity;

  if (flash) return flash.mood;
  if (waiting) return "wave";
  if (busy) return moodOfTool(latestTool(last)) ?? "think";
  if (asleep) return "sleep";
  return messages.length === 0 ? "intro" : "rest";
}
