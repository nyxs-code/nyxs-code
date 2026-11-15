import { listen } from "@tauri-apps/api/event";
import { tool } from "ai";
import { z } from "zod";
import { getLanguage, getTranslations } from "@/lib/i18n";
import { invoke } from "@/lib/ipc";
import { abortChatTurn } from "@/lib/turnAborts";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";
import { COMPUTER_ACTIONS, COMPUTER_LOOK_ACTIONS } from "./actions";
import { controlsSource, getComputerDescription, shortcutModifier } from "./prompt";

interface Display {
  index: number;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  shotWidth: number;
  shotHeight: number;
}

interface Shot {
  data: string;
  width: number;
  height: number;
  display: Display;
  displays: Display[];
  cursor: [number, number] | null;
}

interface WindowInfo {
  id: number;
  title: string;
  process: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  focused: boolean;
}

interface WindowState {
  windowId: number;
  title: string;
  tree: string;
  count: number;
  truncated: boolean;
}

/** What the Rust side (`computer_act`) takes, coordinates in screenshot space. */
type NativeAction =
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; x?: number; y?: number; button?: string; count?: number; modifiers?: string }
  | { kind: "down" | "up"; x?: number; y?: number; button?: string }
  | { kind: "drag"; from: [number, number]; to: [number, number] }
  | { kind: "scroll"; x?: number; y?: number; dx: number; dy: number; modifiers?: string }
  | { kind: "type"; text: string }
  | { kind: "key"; keys: string }
  | { kind: "hold_key"; keys: string; ms: number };

export type ComputerOutput =
  | { kind: "shot"; text: string; data: string; mediaType: "image/jpeg" }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string };

const point = z.tuple([z.number(), z.number()]);

export const computerInputSchema = z.object({
  action: z.enum(COMPUTER_ACTIONS),
  coordinate: point.optional().describe("[x, y] in the latest screenshot's pixels."),
  start_coordinate: point.optional().describe("Where left_click_drag starts."),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("zoom: [x1, y1, x2, y2] in the screenshot's pixels."),
  text: z.string().optional().describe("type/set_value: the text. key/hold_key: the keys. Clicks and scroll: modifier keys to hold."),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z.number().optional().describe("Wheel clicks to scroll (default 3)."),
  duration: z.number().optional().describe("Seconds, for wait and hold_key."),
  window_id: z.number().optional().describe("focus_window, get_window_state, click_element, set_value: the window_id from list_windows."),
  element_index: z.number().int().min(0).optional().describe("click_element, set_value: the [number] from get_window_state."),
  button: z.enum(["left", "right"]).optional().describe("click_element: which button (default left)."),
  click_count: z.number().int().min(1).max(2).optional().describe("click_element: 2 for a double click."),
  display: z.number().int().min(0).optional().describe("Which monitor (0 = main). Default 0."),
});

export type ComputerInput = z.infer<typeof computerInputSchema>;

/** How long the screen gets to settle before the screenshot that follows an action. */
const SETTLE_MS = 500;
const MAX_WAIT_S = 30;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** The chats whose agents used the computer this turn: their hold is let go when the turn ends. */
const holders = new Set<string>();

/** A chat's turn ended: if its agent held the computer, the frame goes and others may take it. */
export function releaseComputer(chat: string): void {
  if (!holders.delete(chat)) return;
  void invoke("computer_release", { chat }).catch(() => undefined);
}

let lastLabel = "";
let listening = false;

/** Before acting: the frame's label in the app's language, and Esc ending the turn of whoever
 *  held the computer (Rust stops the frame and the actions; the turn itself ends here). */
async function prepareControl(): Promise<void> {
  const label = getTranslations(getLanguage()).codeSettings.computerUseOverlay;
  if (label !== lastLabel) {
    lastLabel = label;
    await invoke("computer_set_label", { label }).catch(() => undefined);
  }
  if (listening) return;
  listening = true;
  void listen<string>("computer-stop", ({ payload }) => {
    holders.delete(payload);
    if (payload) abortChatTurn(payload);
  }).catch(() => {
    listening = false;
  });
}

function describeDisplays(shot: Shot): string {
  if (shot.displays.length < 2) return "";
  const list = shot.displays
    .map((d) => `${d.index}${d.primary ? " (main)" : ""}: ${d.width}×${d.height} at ${d.x},${d.y}`)
    .join("; ");
  return ` Displays: ${list}.`;
}

function shotOutput(shot: Shot, lead: string, zoomed: boolean): ComputerOutput {
  const where = zoomed
    ? `Zoomed region of display ${shot.display.index}, ${shot.width}×${shot.height}. Coordinates for actions are still those of the full screenshot (${shot.display.shotWidth}×${shot.display.shotHeight}), not of this zoom.`
    : `Screenshot of display ${shot.display.index}, ${shot.width}×${shot.height}${shot.cursor ? `, pointer at (${shot.cursor[0]}, ${shot.cursor[1]})` : ""}.${describeDisplays(shot)}`;
  return { kind: "shot", text: [lead, where].filter(Boolean).join("\n"), data: shot.data, mediaType: "image/jpeg" };
}

function describeWindows(list: WindowInfo[]): string {
  if (list.length === 0) return "No app windows are open.";
  const rows = list.map((w) => {
    const state = [w.focused ? "focused" : "", w.minimized ? "minimized" : ""].filter(Boolean).join(", ");
    return `- window_id ${w.id}: "${w.title}" (${w.process || "unknown process"})${state ? ` [${state}]` : ""}`;
  });
  return `Open windows, front to back:\n${rows.join("\n")}`;
}

function describeWindowState(s: WindowState): string {
  if (s.count === 0) {
    return `Window ${s.windowId} "${s.title}" exposes no controls to ${controlsSource()} (common in games and some custom-drawn apps). Work from the screenshot and coordinates instead.`;
  }
  return [
    `Controls of window ${s.windowId} "${s.title}" (${s.count}${s.truncated ? ", cut short: the window has more" : ""}). Act on one with click_element or set_value and its [number]; the numbers hold until the window changes, then read it again.`,
    s.tree,
  ].join("\n");
}

/** The model's call to what Rust does, or why the call can't be done. */
export function toNativeAction(input: Pick<ComputerInput, "action" | "coordinate" | "start_coordinate" | "text" | "scroll_direction" | "scroll_amount" | "duration">): NativeAction | string {
  const { action, coordinate: c, text } = input;
  const at = c ? { x: c[0], y: c[1] } : {};
  const mods = text?.trim() || undefined;
  switch (action) {
    case "left_click":
      return { kind: "click", ...at, button: "left", modifiers: mods };
    case "right_click":
      return { kind: "click", ...at, button: "right", modifiers: mods };
    case "middle_click":
      return { kind: "click", ...at, button: "middle", modifiers: mods };
    case "double_click":
      return { kind: "click", ...at, button: "left", count: 2, modifiers: mods };
    case "triple_click":
      return { kind: "click", ...at, button: "left", count: 3, modifiers: mods };
    case "mouse_move":
      return c ? { kind: "move", x: c[0], y: c[1] } : "mouse_move needs coordinate.";
    case "left_click_drag":
      return c && input.start_coordinate
        ? { kind: "drag", from: input.start_coordinate, to: c }
        : "left_click_drag needs start_coordinate and coordinate.";
    case "left_mouse_down":
      return { kind: "down", ...at, button: "left" };
    case "left_mouse_up":
      return { kind: "up", ...at, button: "left" };
    case "scroll": {
      const n = Math.max(1, Math.min(50, Math.round(input.scroll_amount ?? 3)));
      const dir = input.scroll_direction ?? "down";
      const dy = dir === "down" ? n : dir === "up" ? -n : 0;
      const dx = dir === "right" ? n : dir === "left" ? -n : 0;
      return { kind: "scroll", ...at, dx, dy, modifiers: mods };
    }
    case "type":
      return text ? { kind: "type", text } : "type needs text.";
    case "key":
      return text?.trim() ? { kind: "key", keys: text.trim() } : `key needs text, e.g. "${shortcutModifier()}+s".`;
    case "hold_key":
      return text?.trim()
        ? { kind: "hold_key", keys: text.trim(), ms: Math.round(Math.min(10, Math.max(0, input.duration ?? 1)) * 1000) }
        : "hold_key needs text.";
    default:
      return `${action} isn't an input action.`;
  }
}

export interface ComputerRunOptions {
  /** The model sees images: actions answer with a screenshot. */
  allowImages: boolean;
  /** The chat whose agent acts, for the one-session lock and for Esc to stop its turn. */
  chat?: string;
  signal?: AbortSignal;
}

/** Runs one Computer call: shared by the built-in tool and the MCP server for CLI agents. */
export async function runComputer(input: ComputerInput, opts: ComputerRunOptions): Promise<ComputerOutput> {
  const { action, display } = input;
  const { allowImages, signal } = opts;
  const chat = opts.chat ?? null;
  if (opts.chat) holders.add(opts.chat);
  await prepareControl();
  const screenshot = (region: ComputerInput["region"] | null) =>
    invoke<Shot>("computer_screenshot", { chat, display: display ?? null, region: region ?? null });
  const look = async (lead: string): Promise<ComputerOutput> => {
    if (!allowImages) {
      return { kind: "text", text: `${lead}\n[The current model can't see images, so no screenshot. Use get_window_state to read windows as text.]`.trim() };
    }
    return shotOutput(await screenshot(null), lead, false);
  };
  const needsWindow = (): string | null =>
    input.window_id === undefined ? `${action} needs window_id (from list_windows).` : null;
  const needsElement = (): string | null =>
    needsWindow() ?? (input.element_index === undefined ? `${action} needs element_index (from get_window_state).` : null);
  try {
    switch (action) {
      case "screenshot":
        if (!allowImages) {
          return { kind: "error", message: "The current model can't see images. Use list_windows and get_window_state to read windows as text." };
        }
        return await look("");
      case "zoom": {
        if (!input.region) return { kind: "error", message: "zoom needs region [x1, y1, x2, y2]." };
        if (!allowImages) return { kind: "error", message: "The current model can't see images." };
        return shotOutput(await screenshot(input.region), "", true);
      }
      case "cursor_position": {
        const shot = await screenshot(null);
        return {
          kind: "text",
          text: shot.cursor
            ? `The pointer is at (${shot.cursor[0]}, ${shot.cursor[1]}) on display ${shot.display.index}.`
            : `The pointer isn't on display ${shot.display.index}.${describeDisplays(shot)}`,
        };
      }
      case "list_windows":
        return { kind: "text", text: describeWindows(await invoke<WindowInfo[]>("computer_windows", { chat })) };
      case "focus_window": {
        const missing = needsWindow();
        if (missing) return { kind: "error", message: missing };
        await invoke("computer_focus", { chat, id: input.window_id });
        await sleep(SETTLE_MS, signal);
        return await look(`Window ${input.window_id} is in front.`);
      }
      case "get_window_state": {
        const missing = needsWindow();
        if (missing) return { kind: "error", message: missing };
        const state = await invoke<WindowState>("computer_window_state", { chat, id: input.window_id });
        return await look(describeWindowState(state));
      }
      case "click_element":
      case "set_value": {
        const missing = needsElement();
        if (missing) return { kind: "error", message: missing };
        if (action === "set_value" && input.text === undefined) return { kind: "error", message: "set_value needs text." };
        const elementAction =
          action === "set_value" ? "set_value" : input.button === "right" ? "right_click" : input.click_count === 2 ? "double_click" : "click";
        const done = await invoke<string>("computer_element", {
          chat,
          window: input.window_id,
          index: input.element_index,
          action: elementAction,
          text: input.text ?? null,
        });
        await sleep(SETTLE_MS, signal);
        return await look(done);
      }
      case "wait": {
        const s = Math.min(MAX_WAIT_S, Math.max(0, input.duration ?? 1));
        await sleep(s * 1000, signal);
        return await look(`Waited ${s}s.`);
      }
      default: {
        const native = toNativeAction(input);
        if (typeof native === "string") return { kind: "error", message: native };
        if (signal?.aborted) return { kind: "error", message: "Stopped before acting." };
        await invoke("computer_act", { chat, display: display ?? null, action: native });
        await sleep(SETTLE_MS, signal);
        return await look(`Done: ${action}.`);
      }
    }
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Why an action that moves the mouse or keyboard can't run in plan mode. */
export function computerPlanModeMessage(action: string): string {
  return `${action} is blocked: plan mode is active, so the agent may only look at the desktop (screenshot, list_windows, get_window_state), not use it.`;
}

export function createComputerTool(ctx: ToolContext) {
  const { allowImages, nativeToolImages, sessionKey, gate, planMode } = ctx;
  return tool({
    description: getComputerDescription(),
    inputSchema: computerInputSchema,
    execute: async (input, { abortSignal }): Promise<ComputerOutput> => {
      // The gate already refuses this in plan mode; a run without one must not act either.
      if (planMode && !COMPUTER_LOOK_ACTIONS.has(input.action)) return { kind: "error", message: computerPlanModeMessage(input.action) };
      const denied = await checkGate(gate, "Computer", input);
      if (denied) return { kind: "error", message: denied };
      return runComputer(input, { allowImages, chat: sessionKey, signal: abortSignal });
    },
    toModelOutput: ({ output }) => computerModelOutput(output, nativeToolImages),
  });
}

export function computerModelOutput(o: ComputerOutput, nativeToolImages: boolean) {
  if (o.kind === "error") return { type: "error-text" as const, value: o.message };
  if (o.kind === "text") return { type: "text" as const, value: o.text };
  const image = nativeToolImages
    ? { type: "image-data" as const, data: o.data, mediaType: o.mediaType }
    : { type: "file-data" as const, data: o.data, mediaType: o.mediaType, filename: "screenshot.jpg" };
  return { type: "content" as const, value: [{ type: "text" as const, text: o.text || "Screenshot:" }, image] };
}
