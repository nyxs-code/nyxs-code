// postMessage protocol between Nyxs and the video player iframe (nyxs/player.tsx in each
// video project). The player keeps its own copy of these types; keep both in sync with
// docs/video-editor-spec.md.

import type { Timeline, Transform } from "./timelineSchema";

export const PLAYER_MESSAGE_SOURCE = "nyxs-video";

/** Messages Nyxs sends to the player iframe. */
export type ToPlayerMessage =
  | { type: "load"; timeline: Timeline; compositionId: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "seek"; frame: number }
  | { type: "setLoop"; loop: boolean }
  | { type: "setPlaybackRate"; rate: number }
  | { type: "setVolume"; volume: number }
  | { type: "setMuted"; muted: boolean }
  | { type: "setOverlay"; safeAreas: boolean; grid: boolean; selectedClipId: string | null }
  | { type: "setZoom"; zoom: "fit" | number }
  /** Shows one of the project's own compositions (adopted projects); a later `load` goes back to the timeline. */
  | { type: "loadProjectComposition"; compositionId: string; inputProps?: Record<string, unknown> };

/** A composition the project registers in its own Root, as the player reports it. */
export interface ProjectCompositionInfo {
  id: string;
  /** Null when only calculateMetadata provides it. */
  width: number | null;
  height: number | null;
  fps: number | null;
  durationInFrames: number | null;
  /** Null when not JSON-serializable or larger than 50 KB. */
  defaultProps: Record<string, unknown> | null;
  hasCalculateMetadata: boolean;
  still: boolean;
  /** `<Folder>` path like "Extras/Promo", or null. */
  folder: string | null;
}

/** Messages the player iframe sends to Nyxs. */
export type FromPlayerMessage =
  | { type: "ready"; remotionVersion: string }
  | { type: "frame"; frame: number; playing: boolean }
  | { type: "ended" }
  | { type: "error"; message: string; stack?: string }
  | { type: "clipClicked"; clipId: string }
  | { type: "transformDrag"; clipId: string; transform: Transform }
  | { type: "bundleRebuilt" }
  /** Keys pressed while the iframe has focus, so the panel's shortcuts keep working. */
  | { type: "keydown"; key: string; code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }
  /** Sent once after every `ready`: the project's own compositions (`entry` null = no Remotion entry found). */
  | { type: "projectCompositions"; entry: string | null; compositions: ProjectCompositionInfo[]; error?: string };

export type ToPlayerEnvelope = ToPlayerMessage & { source: typeof PLAYER_MESSAGE_SOURCE };
export type FromPlayerEnvelope = FromPlayerMessage & { source: typeof PLAYER_MESSAGE_SOURCE };

const FROM_PLAYER_TYPES: ReadonlySet<string> = new Set<FromPlayerMessage["type"]>([
  "ready",
  "frame",
  "ended",
  "error",
  "clipClicked",
  "transformDrag",
  "bundleRebuilt",
  "keydown",
  "projectCompositions",
]);

/** Sends a message to the player iframe. No-op while the iframe has no window yet. */
export function postToPlayer(iframe: HTMLIFrameElement | null | undefined, message: ToPlayerMessage): void {
  const win = iframe?.contentWindow;
  if (!win) return;
  // The player is served from 127.0.0.1 on a random port; its origin is not secret, and the
  // iframe itself checks that messages come from its parent window.
  win.postMessage({ ...message, source: PLAYER_MESSAGE_SOURCE } satisfies ToPlayerEnvelope, "*");
}

/** True for a well-formed message from the player (use with `event.data`). */
export function isPlayerMessage(data: unknown): data is FromPlayerEnvelope {
  if (typeof data !== "object" || data === null) return false;
  const d = data as { source?: unknown; type?: unknown };
  return d.source === PLAYER_MESSAGE_SOURCE && typeof d.type === "string" && FROM_PLAYER_TYPES.has(d.type);
}
