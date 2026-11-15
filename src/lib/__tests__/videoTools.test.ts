import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const openRequests: { chat?: string; slug: string }[] = [];

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    const key = `${String(args?.workspace)}|${String(args?.slug)}`;
    if (cmd === "video_list_projects") return [...files.keys()].filter((k) => k.startsWith(`${String(args.workspace)}|`)).map((k) => ({ slug: k.split("|")[1], name: k.split("|")[1], kind: "nyxs", path: "", compositions: [], installed: true, updatedAt: 0 }));
    if (cmd === "video_read_timeline") {
      const text = files.get(key);
      if (text === undefined) throw new Error("no such project");
      return text;
    }
    if (cmd === "video_write_timeline") {
      files.set(key, args.json as string);
      return undefined;
    }
    if (cmd === "video_runtime_status") return { installed: true };
    throw new Error(`unexpected command ${cmd}`);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/video/videoOpen", () => ({
  OPEN_VIDEO_EVENT: "nyxs:open-video",
  takePendingVideoOpen: () => null,
  requestVideoOpen: (r: { chat?: string; slug: string }) => openRequests.push(r),
}));
vi.mock("@/lib/workspace", () => ({ loadWorkspace: () => "/w" }));

import { emptyTimeline, type Timeline } from "@/lib/video/timelineSchema";
import { checkPermission } from "@/lib/permissions";
import { describeToolCall } from "@/lib/toolDetail";
import { closeTimeline, getTimelineState, openTimeline, resetTimelineStoreForTests, setTimelineIo } from "@/lib/video/timelineStore";
import { noteVideoChatTurn, resetVideoControlForTests, setVideoChatContext, stopVideoAgent, targetFor } from "@/lib/video/videoControl";
import { handleVideoMcp } from "@/lib/browserMcp";
import { builtinVideoToolName, VIDEO_TOOLS, videoCallReadOnly, videoToolFor, type VideoToolResult } from "@/lib/videoTools";

function seed(slug: string): Timeline {
  const tl = emptyTimeline({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 });
  files.set(`/w|${slug}`, `${JSON.stringify(tl, null, 2)}\n`);
  return tl;
}

const disk = (slug: string) => JSON.parse(files.get(`/w|${slug}`) as string) as Timeline;

const run = (name: string, input: Record<string, unknown>, chat = "chat-a"): Promise<VideoToolResult> => {
  const def = VIDEO_TOOLS.find((d) => d.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def.run(input, { chat, workspace: "/w" });
};

async function call(name: string, args: Record<string, unknown>, chat = "chat-a") {
  const res = (await handleVideoMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, chat)) as { result: { content: { type: string; text: string }[]; isError?: boolean } };
  return res.result;
}

/** A store that reads and writes the same fake files, as the real one goes through video_*. */
function liveIo() {
  setTimelineIo({
    read: async (w, s) => files.get(`${w}|${s}`) as string,
    write: async (w, s, json) => void files.set(`${w}|${s}`, json),
    watch: () => () => undefined,
  });
}

beforeEach(() => {
  files.clear();
  openRequests.length = 0;
  resetVideoControlForTests();
  resetTimelineStoreForTests();
  setTimelineIo();
});

describe("the MCP server", () => {
  it("lists every tool with instructions and read-only hints", async () => {
    const init = (await handleVideoMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as { result: { instructions: string; serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("nyxs-video");
    expect(init.result.instructions).toMatch(/snapshot, act, contact_sheet or screenshot, fix/);
    expect(init.result.instructions).toMatch(/render\.mjs/);
    const list = (await handleVideoMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    const byName = new Map(list.result.tools.map((t) => [t.name, t.annotations.readOnlyHint]));
    expect(byName.get("snapshot")).toBe(true);
    expect(byName.get("seek")).toBe(true);
    expect(byName.get("add_clip")).toBe(false);
    expect(byName.get("render")).toBe(false);
  });

  it("names tools both ways", () => {
    expect(builtinVideoToolName("add_clip")).toBe("VideoAddClip");
    expect(videoToolFor("VideoAddClip")?.name).toBe("add_clip");
    expect(videoToolFor("mcp__nyxs-video__add_clip")?.name).toBe("add_clip");
    expect(videoToolFor("VideoCreate")).toBeUndefined();
  });

  it("keeps a chip for new calls and for tools from old transcripts", () => {
    expect(describeToolCall("mcp__nyxs-video__add_clip", { clip: { type: "text", text: "Hi" } })).toEqual({ name: "Video", detail: "add_clip · Hi" });
    expect(describeToolCall("VideoSeek", { frame: 12 })).toEqual({ name: "Video", detail: "seek · 12" });
    expect(describeToolCall("VideoCreate", { name: "Teaser" })).toEqual({ name: "VideoCreate", detail: "Teaser" });
    expect(describeToolCall("VideoStill", { project: "x", frames: [1, 2] })).toEqual({ name: "VideoStill", detail: "x · 1, 2" });
  });
});

describe("permissions", () => {
  it("lets reads through in every mode and follows the mode for edits", () => {
    for (const mode of ["ask", "plan", "acceptEdits", "auto", "skip"] as const) {
      expect(checkPermission("mcp__nyxs-video__snapshot", {}, mode, [])).toBe("allow");
      expect(checkPermission("VideoSeek", { frame: 1 }, mode, [])).toBe("allow");
    }
    expect(checkPermission("mcp__nyxs-video__add_clip", {}, "ask", [])).toBe("ask");
    expect(checkPermission("VideoAddClip", {}, "acceptEdits", [])).toBe("allow");
    expect(checkPermission("VideoRender", {}, "skip", [])).toBe("allow");
    expect(checkPermission("VideoAddClip", {}, "plan", [])).toBe("deny");
  });

  it("treats a batch of only reads as a read", () => {
    const batch = videoToolFor("VideoBatch")!;
    expect(videoCallReadOnly(batch, { actions: [{ tool: "seek" }, { tool: "screenshot" }] })).toBe(true);
    expect(videoCallReadOnly(batch, { actions: [{ tool: "seek" }, { tool: "delete_clips" }] })).toBe(false);
    expect(videoCallReadOnly(batch, { actions: [] })).toBe(false);
    expect(checkPermission("VideoBatch", { actions: [{ tool: "seek" }] }, "plan", [])).toBe("allow");
    expect(checkPermission("VideoBatch", { actions: [{ tool: "add_clip" }] }, "plan", [])).toBe("deny");
  });

  it("refuses edits on the MCP path in plan mode, and reads still work", async () => {
    seed("p");
    noteVideoChatTurn("chat-a", "plan");
    await expect(call("snapshot", {})).resolves.toMatchObject({ content: [{ text: expect.stringContaining("videos/p") }] });
    const denied = await call("add_clip", { clip: { type: "text", text: "x" } });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/plan mode/);
    expect(disk("p").compositions[0].tracks.every((t) => t.clips.length === 0)).toBe(true);
  });
});

describe("errors the model can act on", () => {
  beforeEach(async () => {
    seed("p");
    await run("add_clip", { clip: { id: "t1", type: "text", text: "One", from: 0, durationInFrames: 30 } });
    await run("add_clip", { clip: { id: "t2", type: "text", text: "Two", from: 60, durationInFrames: 30 } });
  });

  it("an unknown clip lists the valid ones", async () => {
    const r = await call("update_clip", { clip_id: "nope", patch: { text: "x" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/No clip "nope"/);
    expect(r.content[0].text).toMatch(/t1 \(text, 0–30\)/);
    expect(r.content[0].text).toMatch(/t2 \(text, 60–90\)/);
  });

  it("a locked track says how to unlock", async () => {
    const comp = disk("p").compositions[0];
    const track = comp.tracks.find((t) => t.clips.some((c) => c.id === "t1"))!;
    await run("track", { action: "set", track_id: track.id, locked: true });
    const r = await call("delete_clips", { clip_ids: ["t1"] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/is locked/);
    expect(r.content[0].text).toContain(`track_id: "${track.id}", locked: false`);
    expect(disk("p").compositions[0].tracks.flatMap((t) => t.clips).map((c) => c.id)).toContain("t1");
  });

  it("an overlap names the clip and the next free frame", async () => {
    const r = await call("move_clips", { clip_ids: ["t2"], frame: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/overlap "t1"/);
    expect(r.content[0].text).toMatch(/next free frame there is 30/);
    expect(disk("p").compositions[0].tracks.flatMap((t) => t.clips).find((c) => c.id === "t2")?.from).toBe(60);
  });

  it("the schema still guards what the tools don't check", async () => {
    const r = await call("update_clip", { clip_id: "t1", patch: { style: { fontSize: -4 } } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/fontSize/);
  });

  it("a trim outside its limits gives them", async () => {
    const r = await call("trim_clip", { clip_id: "t2", edge: "start", frame: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/between frames 30 and 89/);
  });

  it("a split where nothing plays says so", async () => {
    const r = await call("split_clips", { frame: 200 });
    expect(r.content[0].text).toMatch(/No clip is under frame 200/);
  });

  it("a chat with no project is told which there are", async () => {
    seed("q");
    const r = await call("snapshot", {}, "chat-new");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/no video project open/);
    expect(r.content[0].text).toMatch(/p \("p"\), q \("q"\)/);
  });
});

describe("batch", () => {
  it("is one undo step, and stops at the first failure", async () => {
    seed("p");
    const done = await run("batch", { actions: [
      { tool: "add_clip", input: { clip: { id: "a", type: "text", text: "A", from: 0, durationInFrames: 30 } } },
      { tool: "add_clip", input: { clip: { id: "b", type: "text", text: "B", from: 30, durationInFrames: 30 } } },
      { tool: "split_clips", input: { clip_ids: ["a"], frame: 15 } },
    ] });
    expect(done.text).toMatch(/1\. add_clip/);
    expect(disk("p").compositions[0].tracks.flatMap((t) => t.clips)).toHaveLength(3);
    await run("undo", {});
    expect(disk("p").compositions[0].tracks.flatMap((t) => t.clips)).toHaveLength(0);
    await run("redo", {});
    expect(disk("p").compositions[0].tracks.flatMap((t) => t.clips)).toHaveLength(3);

    await expect(run("batch", { actions: [
      { tool: "add_clip", input: { clip: { id: "c", type: "text", text: "C", from: 100, durationInFrames: 30 } } },
      { tool: "update_clip", input: { clip_id: "gone", patch: {} } },
      { tool: "add_clip", input: { clip: { id: "d", type: "text", text: "D", from: 200, durationInFrames: 30 } } },
    ] })).rejects.toThrow(/2\. update_clip failed: No clip "gone"[\s\S]*The other 1 action wasn't run/);
    const ids = disk("p").compositions[0].tracks.flatMap((t) => t.clips).map((c) => c.id);
    expect(ids).toContain("c");
    expect(ids).not.toContain("d");
  });
});

describe("routing", () => {
  it("edits the live store when the project is open there, and nothing touches the file behind it", async () => {
    seed("p");
    liveIo();
    await openTimeline("/w", "p");
    setVideoChatContext({ active: () => "chat-a", workspaceOf: () => "/w" });
    const before = files.get("/w|p");
    await run("add_clip", { clip: { id: "t1", type: "text", text: "Hi", from: 0, durationInFrames: 30 } });
    // In the store and on its undo stack, written only by its own debounced save.
    expect(getTimelineState().timeline?.compositions[0].tracks.flatMap((t) => t.clips).map((c) => c.id)).toEqual(["t1"]);
    expect(getTimelineState().canUndo).toBe(true);
    expect(getTimelineState().selection.clipIds).toEqual(["t1"]);
    expect(files.get("/w|p")).toBe(before);
    await run("undo", {});
    expect(getTimelineState().timeline?.compositions[0].tracks.flatMap((t) => t.clips)).toHaveLength(0);
    await closeTimeline();
  });

  it("a chat in the background edits headless, without taking the live editor", async () => {
    seed("shown");
    seed("other");
    liveIo();
    await openTimeline("/w", "shown");
    setVideoChatContext({ active: () => "chat-a", workspaceOf: () => "/w" });
    await run("open_project", { project: "other" }, "chat-b").catch((e: unknown) => {
      throw e;
    });
    expect(openRequests.at(-1)).toMatchObject({ chat: "chat-b", slug: "other" });
    await run("add_clip", { clip: { id: "x", type: "text", text: "Bg", from: 0, durationInFrames: 30 } }, "chat-b");
    expect(getTimelineState().project?.slug).toBe("shown");
    expect(getTimelineState().timeline?.compositions[0].tracks.flatMap((t) => t.clips)).toHaveLength(0);
    expect(disk("other").compositions[0].tracks.flatMap((t) => t.clips).map((c) => c.id)).toEqual(["x"]);
    const t = await targetFor({ chat: "chat-b", workspace: "/w" });
    expect(t.kind).toBe("headless");
    await closeTimeline();
  });

  it("two chats on one project take turns and neither loses an edit", async () => {
    seed("p");
    await run("open_project", { project: "p" }, "chat-a");
    await run("open_project", { project: "p" }, "chat-b");
    await Promise.all([
      run("add_clip", { clip: { id: "a", type: "text", text: "A", from: 0, durationInFrames: 30 } }, "chat-a"),
      run("add_clip", { clip: { id: "b", type: "text", text: "B", from: 100, durationInFrames: 30 } }, "chat-b"),
      run("add_clip", { clip: { id: "c", type: "text", text: "C", from: 200, durationInFrames: 30 } }, "chat-a"),
    ]);
    expect(disk("p").compositions[0].tracks.flatMap((t) => t.clips).map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    const next = await run("update_clip", { clip_id: "a", patch: { text: "A2" } }, "chat-b");
    expect(next.text).toMatch(/document changed since your last call/);
  });

  it("the headless document picks up a change made to the file", async () => {
    seed("p");
    await run("open_project", { project: "p" });
    await run("add_clip", { clip: { id: "a", type: "text", text: "A", from: 0, durationInFrames: 30 } });
    const edited = disk("p");
    edited.compositions[0].name = "Renamed outside";
    files.set("/w|p", `${JSON.stringify(edited, null, 2)}\n`);
    await run("add_clip", { clip: { id: "b", type: "text", text: "B", from: 40, durationInFrames: 30 } });
    expect(disk("p").compositions[0].name).toBe("Renamed outside");
    expect(disk("p").compositions[0].tracks.flatMap((t) => t.clips).map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("the headless steps go to the store's undo when the project opens there", async () => {
    seed("p");
    await run("open_project", { project: "p" });
    await run("add_clip", { clip: { id: "a", type: "text", text: "A", from: 0, durationInFrames: 30 } });
    liveIo();
    await openTimeline("/w", "p");
    expect(getTimelineState().timeline?.compositions[0].tracks.flatMap((t) => t.clips).map((c) => c.id)).toEqual(["a"]);
    await run("snapshot", {});
    expect(getTimelineState().canUndo).toBe(true);
    await run("undo", {});
    expect(getTimelineState().timeline?.compositions[0].tracks.flatMap((t) => t.clips)).toHaveLength(0);
    await closeTimeline();
  });

  it("a chat with one project takes it and opens the view", async () => {
    seed("only");
    const r = await run("snapshot", {});
    expect(r.text).toMatch(/videos\/only/);
    expect(openRequests).toEqual([expect.objectContaining({ chat: "chat-a", slug: "only" })]);
  });

  it("Stop refuses further edits until the user writes again", async () => {
    seed("p");
    await run("open_project", { project: "p" });
    stopVideoAgent("chat-a");
    await expect(run("add_clip", { clip: { type: "text", text: "x" } })).rejects.toThrow(/pressed Stop/);
    expect((await run("snapshot", {})).text).toMatch(/videos\/p/);
    noteVideoChatTurn("chat-a", "auto");
    await expect(run("add_clip", { clip: { type: "text", text: "x" } })).resolves.toBeTruthy();
  });

  it("transport says why there is no player in the background", async () => {
    seed("p");
    await run("open_project", { project: "p" });
    await expect(run("transport", { action: "play" })).rejects.toThrow(/isn't in the live player right now.*open_project/);
    const seek = await run("seek", { timecode: "00:00:01:00" });
    expect(seek.text).toMatch(/frame 30/);
  });
});

describe("clips from a little input", () => {
  beforeEach(async () => {
    seed("p");
    await run("open_project", { project: "p" });
  });

  it("fills in a text clip and merges its style later", async () => {
    await run("seek", { frame: 45 });
    const r = await run("add_clip", { clip: { type: "text", text: "Hello" } });
    expect(r.text).toMatch(/at frames 45–135/);
    const clip = disk("p").compositions[0].tracks.flatMap((t) => t.clips)[0] as { id: string; style: { color: string; fontWeight: number } };
    await run("update_clip", { clip_id: clip.id, patch: { style: { color: "#FF0000" } } });
    const after = disk("p").compositions[0].tracks.flatMap((t) => t.clips)[0] as { style: { color: string; fontWeight: number } };
    expect(after.style.color).toBe("#FF0000");
    expect(after.style.fontWeight).toBe(clip.style.fontWeight);
  });

  it("splits, reports the new clip, and undo brings back one clip", async () => {
    await run("add_clip", { clip: { id: "t", type: "text", text: "Hi", from: 0, durationInFrames: 60 } });
    const split = await run("split_clips", { clip_ids: ["t"], frame: 20 });
    expect(split.text).toMatch(/Split at frame 20/);
    expect(disk("p").compositions[0].tracks.flatMap((t) => t.clips)).toHaveLength(2);
    await run("undo", {});
    const clips = disk("p").compositions[0].tracks.flatMap((t) => t.clips);
    expect(clips).toHaveLength(1);
    expect(clips[0].durationInFrames).toBe(60);
  });
});
