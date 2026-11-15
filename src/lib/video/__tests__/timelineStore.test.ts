import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, Timeline } from "../timelineSchema";
import {
  beginGesture,
  checkExternalChange,
  closeTimeline,
  endGesture,
  getPlayhead,
  getTimelineState,
  openTimeline,
  resetTimelineStoreForTests,
  serializeTimeline,
  setTimelineIo,
  subscribePlayhead,
  timelineActions,
  updateGesture,
} from "../timelineStore";
import { getComposition, moveClips } from "../timelineOps";

function text(id: string, from: number, durationInFrames: number): Clip {
  return {
    id,
    type: "text",
    from,
    durationInFrames,
    text: id,
    style: { fontFamily: "Inter", fontSize: 40, fontWeight: 600, color: "#ffffff", align: "center" },
  };
}

describe("files formatted by someone else", () => {
  it("leaves them alone when nothing was edited", async () => {
    disk = JSON.stringify(doc([text("a", 0, 30)]), null, 1);
    await openTimeline("ws", "fmt");
    expect(getTimelineState().status).toBe("ready");
    await closeTimeline();
    expect(writes).toEqual([]);
  });

  it("stays unedited after re-reading the same document in another format", async () => {
    disk = serializeTimeline(doc([text("a", 0, 30)]));
    await openTimeline("ws", "fmt2");
    disk = JSON.stringify(doc([text("a", 0, 30)]));
    await checkExternalChange();
    await closeTimeline();
    expect(writes).toEqual([]);
  });

  it("still saves a real edit", async () => {
    disk = JSON.stringify(doc([text("a", 0, 30)]), null, 1);
    await openTimeline("ws", "fmt3");
    timelineActions.apply((tl) => ({ ...tl, assets: [{ id: "x", kind: "image", src: "media/x.png", name: "x" }] }));
    await closeTimeline();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).assets).toHaveLength(1);
  });
});

function doc(clips: Clip[]): Timeline {
  return {
    version: 1,
    assets: [],
    compositions: [
      {
        id: "Main",
        name: "Main",
        width: 1920,
        height: 1080,
        fps: 30,
        durationInFrames: 300,
        background: "#000000",
        tracks: [{ id: "t1", name: "Text", kind: "text", clips }],
        markers: [],
      },
    ],
  };
}

let disk = "";
let writes: string[] = [];
let onChange: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  disk = serializeTimeline(doc([text("a", 0, 30), text("b", 40, 30)]));
  writes = [];
  setTimelineIo({
    read: async () => disk,
    write: async (_w, _s, json) => {
      writes.push(json);
      disk = json;
    },
    watch: (_w, cb) => {
      onChange = cb;
      return () => {
        onChange = null;
      };
    },
  });
});

afterEach(() => {
  resetTimelineStoreForTests();
  setTimelineIo();
  vi.useRealTimers();
});

const clipIds = () => getComposition(getTimelineState().timeline!, "Main")!.tracks[0].clips.map((c) => `${c.id}@${c.from}`);

describe("timelineStore", () => {
  it("opens a project and selects its first composition", async () => {
    await openTimeline("/ws", "intro");
    const s = getTimelineState();
    expect(s.status).toBe("ready");
    expect(s.compositionId).toBe("Main");
    expect(onChange).not.toBeNull();
  });

  it("repairs an unsorted, overlapping timeline.json on load and saves the fix", async () => {
    const bad = doc([text("a", 0, 30), text("b", 40, 30)]);
    bad.compositions[0].tracks[0].clips.push(text("late", 0, 60));
    disk = JSON.stringify(bad);
    await openTimeline("/ws", "intro");
    const s = getTimelineState();
    expect(s.status).toBe("ready");
    expect(s.repaired).toBe(true);
    const tracks = getComposition(s.timeline!, "Main")!.tracks;
    expect(tracks).toHaveLength(2);
    expect(tracks.flatMap((t) => t.clips.map((c) => c.id)).sort()).toEqual(["a", "b", "late"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(writes).toHaveLength(1);
  });

  it("reports an invalid timeline.json", async () => {
    disk = "{ nope";
    await openTimeline("/ws", "intro");
    expect(getTimelineState().status).toBe("error");
  });

  it("undoes and redoes edits and saves debounced", async () => {
    await openTimeline("/ws", "intro");
    timelineActions.select(["a"]);
    timelineActions.nudge(5);
    expect(clipIds()).toEqual(["a@5", "b@40"]);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(writes).toHaveLength(1);
    timelineActions.undo();
    expect(clipIds()).toEqual(["a@0", "b@40"]);
    expect(getTimelineState().canRedo).toBe(true);
    timelineActions.redo();
    expect(clipIds()).toEqual(["a@5", "b@40"]);
  });

  it("coalesces quick nudges into one undo step", async () => {
    await openTimeline("/ws", "intro");
    timelineActions.select(["a"]);
    timelineActions.nudge(1);
    timelineActions.nudge(1);
    timelineActions.nudge(1);
    expect(clipIds()[0]).toBe("a@3");
    timelineActions.undo();
    expect(clipIds()[0]).toBe("a@0");
    expect(getTimelineState().canUndo).toBe(false);
  });

  it("records a drag as one step", async () => {
    await openTimeline("/ws", "intro");
    beginGesture();
    for (const d of [1, 2, 3, 4]) updateGesture((base, c) => moveClips(base, c, ["a"], d));
    endGesture();
    expect(clipIds()[0]).toBe("a@4");
    timelineActions.undo();
    expect(clipIds()[0]).toBe("a@0");
  });

  it("ignores the echo of its own write", async () => {
    await openTimeline("/ws", "intro");
    timelineActions.select(["a"]);
    timelineActions.nudge(5);
    await vi.advanceTimersByTimeAsync(300);
    const before = getTimelineState().timeline;
    onChange!();
    await vi.advanceTimersByTimeAsync(0);
    expect(getTimelineState().timeline).toBe(before);
    expect(getTimelineState().canUndo).toBe(true);
  });

  it("loads outside edits as an undoable step and keeps the selection", async () => {
    await openTimeline("/ws", "intro");
    timelineActions.select(["a", "b"]);
    disk = serializeTimeline(doc([text("a", 10, 30), text("c", 50, 30)]));
    onChange!();
    await vi.advanceTimersByTimeAsync(0);
    expect(clipIds()).toEqual(["a@10", "c@50"]);
    expect(getTimelineState().selection.clipIds).toEqual(["a"]);
    timelineActions.undo();
    expect(clipIds()).toEqual(["a@0", "b@40"]);
  });

  it("keeps its document when the outside edit is invalid", async () => {
    await openTimeline("/ws", "intro");
    disk = JSON.stringify({ version: 1 });
    onChange!();
    await vi.advanceTimersByTimeAsync(0);
    expect(getTimelineState().externalError).toBeTruthy();
    expect(clipIds()).toEqual(["a@0", "b@40"]);
  });

  it("waits for a drag to end before loading an outside edit", async () => {
    await openTimeline("/ws", "intro");
    beginGesture();
    updateGesture((base, c) => moveClips(base, c, ["a"], 2));
    disk = serializeTimeline(doc([text("z", 100, 10)]));
    onChange!();
    await vi.advanceTimersByTimeAsync(0);
    expect(clipIds()).toEqual(["a@2", "b@40"]);
    endGesture();
    expect(clipIds()).toEqual(["z@100"]);
  });

  it("copies, pastes at the playhead and selects the pasted clips", async () => {
    await openTimeline("/ws", "intro");
    timelineActions.select(["a"]);
    expect(timelineActions.copy()).toBe(true);
    timelineActions.setPlayhead(100);
    timelineActions.paste();
    const sel = getTimelineState().selection.clipIds;
    expect(sel).toHaveLength(1);
    expect(clipIds()).toContain(`${sel[0]}@100`);
  });

  it("reports playhead moves with their source and clamps them", async () => {
    await openTimeline("/ws", "intro");
    const seen: string[] = [];
    const off = subscribePlayhead((f, s) => seen.push(`${f}:${s}`));
    timelineActions.setPlayhead(50);
    timelineActions.setPlayhead(9999, "player");
    off();
    expect(seen).toEqual(["50:user", "299:player"]);
    expect(getPlayhead()).toBe(299);
  });

  it("toggles markers and in/out at the playhead", async () => {
    await openTimeline("/ws", "intro");
    timelineActions.setPlayhead(20);
    timelineActions.toggleMarkerAtPlayhead();
    expect(getComposition(getTimelineState().timeline!, "Main")!.markers).toHaveLength(1);
    timelineActions.toggleMarkerAtPlayhead();
    expect(getComposition(getTimelineState().timeline!, "Main")!.markers).toHaveLength(0);
    timelineActions.markIn();
    timelineActions.setPlayhead(80);
    timelineActions.markOut();
    expect(getTimelineState()).toMatchObject({ inPoint: 20, outPoint: 80 });
  });
});
