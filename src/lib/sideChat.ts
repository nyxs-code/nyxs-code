import { useSyncExternalStore } from "react";
import { callModel } from "./callModel";
import { streamClaudeCode } from "./claudeCode";
import { buildModel } from "./modelClient";
import { getModel, PROVIDERS } from "./models";
import type { Settings } from "./settings";

/** The side chat, like Claude Code Desktop's /btw: a quick question that reads the open chat
 *  but adds nothing to it. It runs without tools and isn't saved. Each session has its own: it
 *  opens as a view of the session's side panel, or minimized as a card in a corner of the
 *  window, and switching sessions hides it until that session is back. */
export interface SideTurn {
  role: "user" | "assistant";
  content: string;
}

export type SideCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** One session's side chat. */
export interface SideSession {
  turns: SideTurn[];
  busy: boolean;
  /** Minimized to the corner card instead of a view of the panel. */
  floating: boolean;
  /** A model picked in the side chat's composer; the session's own otherwise. */
  model?: string;
}

interface SideChatState {
  /** The session on screen, whose side chat the shortcuts and commands act on. */
  active: string;
  sessions: Record<string, SideSession>;
  /** Whether the session on screen shows the side chat in its panel (App tells, from the views). */
  docked: boolean;
  /** Where the minimized card sits; one place for every session. */
  corner: SideCorner;
  /** A question to send as soon as it opens (`/btw <question>`). */
  pending: string;
}

const CORNER_KEY = "nyxs.sideChatCorner";
const CORNERS: SideCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

function savedCorner(): SideCorner {
  try {
    const c = localStorage.getItem(CORNER_KEY) as SideCorner | null;
    return c && CORNERS.includes(c) ? c : "bottom-right";
  } catch {
    return "bottom-right";
  }
}

/** A chat not created yet has no id; its side chat goes with the draft. */
export const sideKey = (chatId: string | null | undefined) => chatId ?? "";

const EMPTY: SideSession = { turns: [], busy: false, floating: false };

let state: SideChatState = { active: "", sessions: {}, docked: false, corner: savedCorner(), pending: "" };
const listeners = new Set<() => void>();
const set = (patch: Partial<SideChatState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const patchSession = (key: string, patch: Partial<SideSession>) =>
  set({ sessions: { ...state.sessions, [key]: { ...(state.sessions[key] ?? EMPTY), ...patch } } });

/** The session on screen has messages to ask about. A new session has none, and no id until its
 *  first message: a side chat opened before then would be left behind when it gets one. */
let available = false;
export const setSideChatAvailable = (on: boolean) => { available = on; };

export const useSideChat = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

export const sideChatState = () => state;
export const sideSessionOf = (key: string): SideSession => state.sessions[key] ?? EMPTY;

/** What shows the side chat as a view of the session's panel; App registers it. */
interface SideChatHost {
  dock: () => void;
  undock: () => void;
}
let host: SideChatHost | null = null;
export const setSideChatHost = (h: SideChatHost | null) => { host = h; };
export const setSideChatDocked = (docked: boolean) => { if (docked !== state.docked) set({ docked }); };
export const setSideChatFor = (chatId: string | null) => {
  const key = sideKey(chatId);
  if (key !== state.active) set({ active: key, pending: "" });
};

/** Answers being written, by session: closing a session's side chat stops its own. */
const running = new Map<string, AbortController>();
export const setSideAbort = (key: string, ctrl: AbortController | null) => {
  if (ctrl) running.set(key, ctrl);
  else running.delete(key);
};

/** Stops the answer being written in a session's side chat. */
export function stopSideAnswer(key: string): void {
  running.get(key)?.abort();
  running.delete(key);
}
/** The session's side chat is still there (closing it forgets it). */
export const hasSideSession = (key: string) => key in state.sessions;

const isOpen = () => state.docked || sideSessionOf(state.active).floating;

export function openSideChat(question = ""): void {
  if (!available) return;
  set({ pending: question.trim() });
  if (!sideSessionOf(state.active).floating) host?.dock();
}
export function toggleSideChat(): void {
  if (!available) return;
  if (isOpen()) closeSideChat();
  else openSideChat();
}
/** Closes the session on screen's side chat and forgets its conversation. */
export function closeSideChat(): void {
  const key = state.active;
  running.get(key)?.abort();
  running.delete(key);
  const { [key]: _, ...rest } = state.sessions;
  set({ sessions: rest, pending: "" });
  host?.undock();
}
/** From the panel to the corner card, keeping the conversation. */
export function minimizeSideChat(): void {
  patchSession(state.active, { floating: true });
  host?.undock();
}
/** From the corner card back to the panel. */
export function dockSideChat(): void {
  patchSession(state.active, { floating: false });
  host?.dock();
}
export function setSideCorner(corner: SideCorner): void {
  try { localStorage.setItem(CORNER_KEY, corner); } catch { /* storage unavailable */ }
  set({ corner });
}
export const takePendingQuestion = () => {
  const q = state.pending;
  if (q) set({ pending: "" });
  return q;
};
export const setSideTurns = (key: string, turns: SideTurn[], busy: boolean) => patchSession(key, { turns, busy });
export const setSideModel = (key: string, model: string) => patchSession(key, { model });

/** The corner nearest to a point of the window. */
export function nearestCorner(x: number, y: number, width: number, height: number): SideCorner {
  return `${y < height / 2 ? "top" : "bottom"}-${x < width / 2 ? "left" : "right"}`;
}

const SIDE_SYSTEM = `You answer a quick side question about the conversation below, which the user is having with a coding agent.
You can read the conversation, but you can't run tools, read files or change anything, and nothing you say goes back into that conversation.
Answer directly and briefly, in the language the user writes in. If the answer needs something the conversation doesn't show, say what's missing.`;

const MAX_TURNS = 40;
const MAX_CHARS = 60_000;

/** The main chat as text: its last turns, newest kept whole, with the app's markers removed. */
export function sideContext(messages: { role: string; content: string }[]): string {
  const lines = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => {
      const text = m.content.replace(/⟦(TOOL|TOOLEND|REASONING)⟧[\s\S]*?⟦\/\1⟧|⟦(?:TODO|PLAN)⟧/g, "").trim();
      return `[${m.role === "user" ? "User" : "Agent"}]: ${text}`;
    });
  let out = lines.join("\n\n");
  if (out.length > MAX_CHARS) out = `…${out.slice(-MAX_CHARS)}`;
  return out;
}

/** Asks the side question with the chat's own model; the answer streams through `onDelta`.
 *  Returns false when the model's provider can't take a one-off question (agent CLIs other than
 *  Claude Code run a whole session per call). */
export async function askSideQuestion(opts: {
  modelId: string;
  settings: Settings;
  context: string;
  turns: SideTurn[];
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  const model = getModel(opts.modelId, opts.settings);
  if (!model) return false;
  const history = opts.turns.map((t) => `[${t.role === "user" ? "Question" : "Answer"}]: ${t.content}`).join("\n\n");
  const prompt = `<conversation>\n${opts.context || "(empty)"}\n</conversation>\n\n${history}`;

  if (model.provider === "claude-code") {
    await streamClaudeCode({
      model: { ...model, effortLevels: [] },
      history: [{ role: "user", content: `${SIDE_SYSTEM}\n\n${prompt}` }],
      workspace: null,
      signal: opts.signal,
      planMode: false,
      effort: "low",
      ephemeral: true,
      onChunk: (delta) => opts.onDelta(delta),
    });
    return true;
  }
  if (PROVIDERS[model.provider]?.kind === "agent-cli") return false;

  const result = callModel({
    model: buildModel(model, opts.settings),
    system: SIDE_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    maxOutputTokens: 4000,
    maxRetries: 1,
    abortSignal: opts.signal,
  });
  for await (const delta of result.textStream) opts.onDelta(delta);
  return true;
}
