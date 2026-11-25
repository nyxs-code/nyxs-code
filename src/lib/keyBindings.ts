import { useSyncExternalStore } from "react";
import { getMergedSnapshot, subscribeSettings } from "@/lib/settingsRuntime";
import { isPageShortcut, type PageKey } from "@/lib/pageShortcuts";

/** The app's shortcuts the user can change (Keyboard shortcuts, Ctrl+/). The rest (Enter,
 *  Escape, the arrows, session switching, the environments' Ctrl+Alt+1–9) stay fixed. */
export const SHORTCUT_IDS = [
  "openShortcuts",
  "openSettings",
  "newSession",
  "find",
  "searchSessions",
  "toggleTheme",
  "toggleDiff",
  "togglePreview",
  "selectElement",
  "toggleFiles",
  "toggleTerminal",
  "newTerminal",
  "closePanel",
  "toggleSidebar",
  "transcriptView",
  "sideChat",
  "moveToBackground",
  "modeMenu",
  "modelMenu",
  "effort",
] as const;

export type ShortcutId = (typeof SHORTCUT_IDS)[number];

/** A key combination as it's stored and shown in tooltips: "Ctrl+Shift+D", "Ctrl+`", "F6".
 *  Ctrl stands for Cmd on macOS too. */
export type Chord = string;

export const DEFAULT_BINDINGS: Record<ShortcutId, Chord> = {
  openShortcuts: "Ctrl+/",
  openSettings: "Ctrl+,",
  newSession: "Ctrl+N",
  find: "Ctrl+F",
  searchSessions: "Ctrl+K",
  toggleTheme: "Ctrl+Shift+L",
  toggleDiff: "Ctrl+Shift+D",
  togglePreview: "Ctrl+Shift+B",
  selectElement: "Ctrl+Shift+S",
  toggleFiles: "Ctrl+Shift+F",
  toggleTerminal: "Ctrl+`",
  newTerminal: "Ctrl+Shift+`",
  closePanel: "Ctrl+\\",
  toggleSidebar: "Ctrl+;",
  transcriptView: "Ctrl+O",
  sideChat: "Ctrl+J",
  moveToBackground: "Ctrl+B",
  modeMenu: "Ctrl+Shift+M",
  modelMenu: "Ctrl+Shift+I",
  effort: "Ctrl+Shift+E",
};

/** The user's changes (settings.json `shortcuts`): a chord, or null for no shortcut. */
export type ShortcutOverrides = Partial<Record<string, Chord | null | undefined>>;

interface Parts {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** Punctuation by the key's place on a US keyboard, so a shortcut works on every layout. */
const CODE_KEYS: Record<string, string> = {
  Slash: "/",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
};
const PUNCTUATION = new Set([...Object.values(CODE_KEYS), "`"]);
const F_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/** "`" is a dead key on Spanish and other layouts, so the key where it sits on a US keyboard
 *  counts too: keyCode 192 (VK_OEM_3) is Ñ on a Spanish keyboard, which is why VS Code shows
 *  "Ctrl+Ñ" there. The physical key left of 1 (º) and the "`^" key next to P count too. */
export function isBackquoteKey(e: Pick<KeyboardEvent, "key" | "code" | "keyCode">): boolean {
  return e.key === "`" || e.key === "~" || e.code === "Backquote" || e.keyCode === 192 || (e.key === "Dead" && e.code === "BracketLeft");
}

/** The key part of a chord for a key event, or null for a key no shortcut can use. */
function keyOf(e: KeyboardEvent): string | null {
  if (F_KEY.test(e.key)) return e.key;
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase();
  // Layouts without Latin letters (Cyrillic, Greek…): the letter of the key's place.
  const letter = /^Key([A-Z])$/.exec(e.code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(e.code);
  if (digit) return digit[1];
  if (isBackquoteKey(e)) return "`";
  return CODE_KEYS[e.code] ?? null;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "CapsLock"]);

/** Whether the event is only a modifier going down (the shortcut isn't finished yet). */
export function isModifierOnly(e: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(e.key);
}

/** The chord a key event makes, or null when its key can't be part of one. */
export function chordOf(e: KeyboardEvent): Chord | null {
  const key = keyOf(e);
  if (!key) return null;
  return join({ ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey, key });
}

function join(p: Parts): Chord {
  return `${p.ctrl ? "Ctrl+" : ""}${p.alt ? "Alt+" : ""}${p.shift ? "Shift+" : ""}${p.key}`;
}

/** A chord's parts, or null when it isn't one this app can use (a hand-edited settings.json). */
export function parseChord(chord: unknown): Parts | null {
  if (typeof chord !== "string" || !chord) return null;
  const parts = chord.split("+");
  // "Ctrl++" isn't a key here; "+" alone never is.
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  if (parts.some((m) => m !== "Ctrl" && m !== "Alt" && m !== "Shift") || mods.size !== parts.length) return null;
  const ok = F_KEY.test(key) || /^[A-Z0-9]$/.test(key) || PUNCTUATION.has(key);
  if (!ok) return null;
  return { ctrl: mods.has("Ctrl"), alt: mods.has("Alt"), shift: mods.has("Shift"), key };
}

/** Whether a key event is this chord. Punctuation also matches by its character, without
 *  looking at Shift, where the layout needs Shift to type it ("/" is Shift+7 in Spanish). */
export function matchesChord(chord: Chord | null | undefined, e: KeyboardEvent): boolean {
  if (!chord) return false;
  if (chordOf(e) === chord) return true;
  const p = parseChord(chord);
  if (!p || p.shift || p.alt || p.key === "`" || !PUNCTUATION.has(p.key)) return false;
  return e.key === p.key && (e.ctrlKey || e.metaKey) === p.ctrl && !e.altKey;
}

/** The keys to draw for a chord, the way the shortcuts list shows them. */
export function chordKeys(chord: Chord): string[] {
  const p = parseChord(chord);
  if (!p) return [];
  return [...(p.ctrl ? ["Ctrl"] : []), ...(p.alt ? ["Alt"] : []), ...(p.shift ? ["⇧"] : []), p.key];
}

/** The overrides kept in the user's settings, dropping anything that isn't a usable chord. */
export function readOverrides(raw: unknown): Partial<Record<ShortcutId, Chord | null>> {
  const out: Partial<Record<ShortcutId, Chord | null>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const id of SHORTCUT_IDS) {
    const v = (raw as Record<string, unknown>)[id];
    if (v === null) out[id] = null;
    else if (parseChord(v) && !problemWith(v as Chord)) out[id] = v as Chord;
  }
  return out;
}

export type Bindings = Record<ShortcutId, Chord | null>;

/** Every shortcut's chord with the user's changes applied (null: no shortcut). */
export function resolveBindings(raw: unknown): Bindings {
  const over = readOverrides(raw);
  const out = { ...DEFAULT_BINDINGS } as Bindings;
  for (const id of SHORTCUT_IDS) if (id in over) out[id] = over[id] ?? null;
  return out;
}

let cachedRaw: unknown = Symbol("unset");
let cached: Bindings = { ...DEFAULT_BINDINGS };

/** The shortcuts now, read from the settings (kept until they change). */
export function currentBindings(): Bindings {
  const raw = (getMergedSnapshot() as { shortcuts?: unknown }).shortcuts;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = resolveBindings(raw);
  }
  return cached;
}

/** The shortcut a key event is, if any. */
export function shortcutFor(e: KeyboardEvent, bindings: Bindings = currentBindings()): ShortcutId | null {
  return SHORTCUT_IDS.find((id) => matchesChord(bindings[id], e)) ?? null;
}

/** Whether a key event is this shortcut now. */
export function isShortcut(id: ShortcutId, e: KeyboardEvent): boolean {
  return matchesChord(currentBindings()[id], e);
}

/** The shortcuts, kept up to date in a component. */
export function useBindings(): Bindings {
  return useSyncExternalStore(subscribeSettings, currentBindings, currentBindings);
}

/** A shortcut's keys for a tooltip ("Ctrl+Shift+D"), or undefined when it has none. */
export function useShortcutLabel(id: ShortcutId): string | undefined {
  return useBindings()[id] ?? undefined;
}

/** A chord for `aria-keyshortcuts` ("Control+Shift+D"). */
export function ariaKeys(chord: Chord | null | undefined): string | undefined {
  return chord ? chord.replace(/^Ctrl\+/, "Control+") : undefined;
}

// While the shortcuts list records a new one, the app's shortcuts don't fire.
let recording = false;
export function setRecordingShortcut(on: boolean): void {
  recording = on;
}
export function isRecordingShortcut(): boolean {
  return recording;
}

/** Combinations kept for text editing, the clipboard and the window: a shortcut can't take them. */
const RESERVED = new Set([
  "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+Shift+V",
  "Ctrl+R", "Ctrl+Shift+R", "Ctrl+W", "Ctrl+Q", "Ctrl+P", "Ctrl+S",
  "F5", "F11", "F12", "Ctrl+=", "Ctrl+-", "Ctrl+0",
]);

/** Shortcuts that can't be changed, by their chord: a new one can't take their keys. */
export type FixedShortcut = "nextSession" | "previousSession" | "newBrowserTab" | "diffFileList";
const FIXED: Record<string, FixedShortcut> = {
  "Ctrl+Shift+]": "nextSession",
  "Ctrl+Shift+[": "previousSession",
  "Ctrl+T": "newBrowserTab",
  "Ctrl+Shift+Y": "diffFileList",
};

export type ChordProblem =
  | { kind: "needsModifier" }
  | { kind: "reserved" }
  | { kind: "fixed"; by: FixedShortcut };

/** Why a chord can't be a shortcut, or null when it can. */
export function problemWith(chord: Chord): ChordProblem | null {
  const p = parseChord(chord);
  if (!p) return { kind: "needsModifier" };
  // Alt: AltGr arrives as Ctrl+Alt on Windows and types characters with it.
  if (p.alt || (!p.ctrl && !F_KEY.test(p.key))) return { kind: "needsModifier" };
  if (RESERVED.has(chord)) return { kind: "reserved" };
  const by = FIXED[chord];
  return by ? { kind: "fixed", by } : null;
}

/** The other shortcuts that use this chord now. */
export function clashesWith(id: ShortcutId, chord: Chord, bindings: Bindings): ShortcutId[] {
  return SHORTCUT_IDS.filter((other) => other !== id && bindings[other] === chord);
}

/** The settings change that gives `id` this chord (null: none), back to its default when it's
 *  the default. Clashing shortcuts listed in `clear` lose theirs. */
export function overridesFor(id: ShortcutId, chord: Chord | null, clear: ShortcutId[] = []): ShortcutOverrides {
  const out: ShortcutOverrides = { [id]: chord === DEFAULT_BINDINGS[id] ? undefined : chord };
  for (const other of clear) out[other] = null;
  return out;
}

/** The settings change that puts every shortcut back to its default. */
export function resetAllOverrides(): ShortcutOverrides {
  return Object.fromEntries(SHORTCUT_IDS.map((id) => [id, undefined]));
}

/** A shortcut's chord as a key typed in a page of the built-in browser. */
function pageKeyOf(chord: Chord): PageKey | null {
  const p = parseChord(chord);
  if (!p) return null;
  const code = /^[A-Z]$/.test(p.key)
    ? `Key${p.key}`
    : /^[0-9]$/.test(p.key)
      ? `Digit${p.key}`
      : p.key === "`"
        ? "Backquote"
        : (Object.entries(CODE_KEYS).find(([, k]) => k === p.key)?.[0] ?? p.key);
  return { key: p.key.length === 1 ? p.key.toLowerCase() : p.key, code, keyCode: 0, shiftKey: p.shift, ctrlKey: p.ctrl, metaKey: false };
}

/** Whether the key still reaches the app with the focus in a page of the built-in browser. */
export function worksInPages(chord: Chord): boolean {
  const k = pageKeyOf(chord);
  return k ? isPageShortcut(k) : false;
}
