import { useCallback, useEffect, useRef, useState } from "react";
import { isPlayerMessage, postToPlayer, type FromPlayerMessage, type ToPlayerMessage } from "@/lib/video/playerProtocol";
import { getPlayhead, getTimelineState, setPlayhead, subscribePlayhead, timelineActions, useTimelineStore } from "@/lib/video/timelineStore";
import { logVideoEvent, registerLivePlayer } from "@/lib/video/videoControl";
import { acquirePlayer, releasePlayer, resetPlayer } from "./playerClient";

/** How long the player may take to say "ready" before the panel shows what went wrong. */
const READY_TIMEOUT_MS = 20_000;

export type PlayerZoom = "fit" | number;

export const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2, 4];
const SHUTTLE = [1, 2, 4];

export interface PlayerState {
  url: string | null;
  startError: string | null;
  ready: boolean;
  playing: boolean;
  loop: boolean;
  /** Negative while shuttling backwards (J). */
  rate: number;
  volume: number;
  muted: boolean;
  zoom: PlayerZoom;
  safeAreas: boolean;
  grid: boolean;
  sceneError: { message: string; stack?: string } | null;
  /** The iframe's page finished loading (its load event). */
  loaded: boolean;
  /** The last message the player sent, for the "didn't start" diagnosis. */
  lastMessage: string | null;
  /** No "ready" within READY_TIMEOUT_MS. */
  timedOut: boolean;
}

const INITIAL: PlayerState = {
  url: null,
  startError: null,
  ready: false,
  playing: false,
  loop: false,
  rate: 1,
  volume: 1,
  muted: false,
  zoom: "fit",
  safeAreas: false,
  grid: false,
  sceneError: null,
  loaded: false,
  lastMessage: null,
  timedOut: false,
};

/** The project's player iframe: starts its server, keeps it in sync with the store (document,
 *  composition, playhead, selection) and turns its messages into store changes. */
export function usePlayer(workspace: string, slug: string, serverEpoch = 0, visible = true) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<PlayerState>(INITIAL);
  const [attempt, setAttempt] = useState(0);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const patch = useCallback((p: Partial<PlayerState>) => setState((s) => ({ ...s, ...p })), []);

  const timeline = useTimelineStore((s) => s.timeline);
  const compositionId = useTimelineStore((s) => s.compositionId);
  const selectedClipId = useTimelineStore((s) => (s.selection.clipIds.length === 1 ? s.selection.clipIds[0] : null));

  const send = useCallback((msg: ToPlayerMessage) => postToPlayer(iframeRef.current, msg), []);

  // The view stays mounted while hidden: it must not keep playing out of sight.
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) send({ type: "pause" });
  }, [visible, send]);

  /** Play or pause. Before "ready" the player can't take it, so it is remembered (and the button
   *  shows it) until the ready handler sends it. */
  const wantPlaying = useCallback((playing: boolean) => {
    if (stateRef.current.ready) send({ type: playing ? "play" : "pause" });
    else patch({ playing });
  }, [patch, send]);

  // The project's player server, shared and stopped a moment after the last user (see
  // playerClient.ts for the start/stop race this avoids).
  useEffect(() => {
    let alive = true;
    acquirePlayer(workspace, slug)
      // A different URL is a new server: its page has to load and say "ready" again.
      .then((info) => {
        if (!alive) return;
        setState((s) => (s.url === info.url ? s : { ...s, url: info.url, ready: false, loaded: false, lastMessage: null, timedOut: false }));
      })
      .catch((e) => {
        if (!alive) return;
        const startError = e instanceof Error ? e.message : String(e);
        patch({ startError });
        logVideoEvent(workspace, slug, { level: "error", source: "player", message: `The player didn't start: ${startError}` });
      });
    return () => {
      alive = false;
      releasePlayer(workspace, slug);
    };
  }, [workspace, slug, attempt, serverEpoch, patch]);

  // Never spin forever: no "ready" in time shows what is known instead.
  useEffect(() => {
    if (state.ready || state.startError || state.timedOut) return;
    const id = setTimeout(() => patch({ timedOut: true }), READY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [state.ready, state.startError, state.timedOut, attempt, patch]);

  /** Everything the player needs after it (re)loads. */
  const pushAll = useCallback(() => {
    const s = getTimelineState();
    const st = stateRef.current;
    if (s.timeline && s.compositionId) send({ type: "load", timeline: s.timeline, compositionId: s.compositionId });
    send({ type: "setLoop", loop: st.loop });
    send({ type: "setPlaybackRate", rate: st.rate });
    send({ type: "setVolume", volume: st.volume });
    send({ type: "setMuted", muted: st.muted });
    send({ type: "setZoom", zoom: st.zoom });
    send({ type: "setOverlay", safeAreas: st.safeAreas, grid: st.grid, selectedClipId: s.selection.clipIds.length === 1 ? s.selection.clipIds[0] : null });
    send({ type: "seek", frame: getPlayhead() });
  }, [send]);

  // The source is checked against the iframe that exists WHEN the message arrives. Capturing
  // the iframe when the effect ran lost every message: the iframe mounts only once the timeline
  // is ready (often after the server's URL arrived), and React may mount a new one later, each
  // with its own window. That left the player on "Starting…" forever.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || event.source !== win || !isPlayerMessage(event.data)) return;
      handle(event.data);
    };
    const handle = (msg: FromPlayerMessage) => {
      if (msg.type !== "frame" && stateRef.current.lastMessage !== msg.type) patch({ lastMessage: msg.type });
      switch (msg.type) {
        case "ready":
          patch({ ready: true, sceneError: null, timedOut: false });
          pushAll();
          // Play pressed during the wait; pushAll restored everything else.
          if (stateRef.current.playing && visibleRef.current) send({ type: "play" });
          break;
        case "frame":
          if (stateRef.current.ready && stateRef.current.playing !== msg.playing) patch({ playing: msg.playing });
          setPlayhead(msg.frame, "player");
          break;
        case "ended":
          patch({ playing: false });
          break;
        case "error":
          patch({ sceneError: { message: msg.message, stack: msg.stack } });
          logVideoEvent(workspace, slug, { level: "error", source: /^Build failed/.test(msg.message) ? "build" : "scene", message: msg.stack ?? msg.message });
          break;
        case "clipClicked":
          timelineActions.select([msg.clipId]);
          break;
        case "transformDrag":
          // One drag on the canvas is one undo step.
          timelineActions.updateClip(msg.clipId, { transform: msg.transform }, `canvas:${msg.clipId}`);
          break;
        case "bundleRebuilt":
          patch({ sceneError: null });
          pushAll();
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [patch, pushAll, send, workspace, slug]);

  // The document and composition: an instant re-render in the player.
  useEffect(() => {
    if (state.ready && timeline && compositionId) send({ type: "load", timeline, compositionId });
  }, [state.ready, timeline, compositionId, send]);

  // A playhead moved by the user (timeline, keys, inspector) is a seek; the player's own frames
  // are not sent back.
  useEffect(() => {
    if (!state.ready) return;
    return subscribePlayhead((frame, source) => {
      if (source === "user") send({ type: "seek", frame });
    });
  }, [state.ready, send]);

  useEffect(() => {
    if (state.ready) send({ type: "setOverlay", safeAreas: state.safeAreas, grid: state.grid, selectedClipId });
  }, [state.ready, state.safeAreas, state.grid, selectedClipId, send]);

  const durationOf = () => {
    const s = getTimelineState();
    return s.timeline?.compositions.find((c) => c.id === s.compositionId)?.durationInFrames ?? 1;
  };

  const seek = useCallback((frame: number) => {
    setPlayhead(Math.max(0, Math.min(durationOf() - 1, Math.round(frame))));
  }, []);

  const setRate = useCallback((rate: number) => {
    patch({ rate });
    send({ type: "setPlaybackRate", rate });
  }, [patch, send]);

  const actions = {
    toggle: () => {
      // Space always plays forward at the chosen speed, even after shuttling backwards.
      if (!stateRef.current.playing && stateRef.current.rate < 0) setRate(1);
      if (stateRef.current.ready) send({ type: "toggle" });
      else patch({ playing: !stateRef.current.playing });
    },
    play: () => wantPlaying(true),
    pause: () => wantPlaying(false),
    step: (frames: number) => {
      wantPlaying(false);
      seek(getPlayhead() + frames);
    },
    toStart: () => seek(0),
    toEnd: () => seek(durationOf() - 1),
    seek,
    /** L / J: play forwards / backwards, faster on each press (1×, 2×, 4×). K stops. */
    shuttle: (dir: 1 | -1) => {
      const st = stateRef.current;
      const same = st.playing && Math.sign(st.rate) === dir;
      const idx = same ? Math.min(SHUTTLE.length - 1, SHUTTLE.indexOf(Math.abs(st.rate)) + 1) : 0;
      setRate(dir * SHUTTLE[Math.max(0, idx)]);
      wantPlaying(true);
    },
    stopShuttle: () => {
      wantPlaying(false);
      if (stateRef.current.rate < 0 || Math.abs(stateRef.current.rate) > 1) setRate(1);
    },
    setRate,
    setLoop: (loop: boolean) => {
      patch({ loop });
      send({ type: "setLoop", loop });
    },
    setVolume: (volume: number) => {
      patch({ volume, muted: volume === 0 });
      send({ type: "setVolume", volume });
      send({ type: "setMuted", muted: volume === 0 });
    },
    setMuted: (muted: boolean) => {
      patch({ muted });
      send({ type: "setMuted", muted });
    },
    setZoom: (zoom: PlayerZoom) => {
      patch({ zoom });
      send({ type: "setZoom", zoom });
    },
    setSafeAreas: (safeAreas: boolean) => patch({ safeAreas }),
    setGrid: (grid: boolean) => patch({ grid }),
    dismissError: () => patch({ sceneError: null }),
    retry: () => {
      setState((s) => ({ ...s, url: null, startError: null, ready: false, playing: false, loaded: false, lastMessage: null, timedOut: false }));
      void resetPlayer(workspace, slug).then(() => setAttempt((a) => a + 1));
    },
    frameLoaded: () => patch({ loaded: true }),
  };

  // The agent's video tools drive this same player.
  const actionsRef = useRef(actions);
  useEffect(() => { actionsRef.current = actions; });
  useEffect(
    () =>
      registerLivePlayer({
        workspace,
        slug,
        iframe: () => iframeRef.current,
        state: () => stateRef.current,
        actions: () => actionsRef.current,
        cleanOverlay: async (run) => {
          send({ type: "setOverlay", safeAreas: false, grid: false, selectedClipId: null });
          // A frame for the player to redraw without them.
          await new Promise((r) => setTimeout(r, 80));
          try {
            return await run();
          } finally {
            const st = stateRef.current;
            const { clipIds } = getTimelineState().selection;
            send({ type: "setOverlay", safeAreas: st.safeAreas, grid: st.grid, selectedClipId: clipIds.length === 1 ? clipIds[0] : null });
          }
        },
      }),
    [workspace, slug, send],
  );

  return { iframeRef, state, actions };
}

export type PlayerActions = ReturnType<typeof usePlayer>["actions"];
