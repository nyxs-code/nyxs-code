// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  page: { title: "Nosotros", artist: "Anuel AA", cover: null, signedIn: true, loaded: true, playing: true, position: 1, duration: 200, volume: 1 } as Record<string, unknown>,
  searched: [] as string[],
  scripts: [] as string[],
}));

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async (cmd: string, args: { url?: string; script?: string; path?: string }) => {
    if (cmd === "preview_open") {
      if (args.url) fake.searched.push(args.url);
      return undefined;
    }
    if (cmd === "music_page_run") {
      const script = args.script ?? "";
      fake.scripts.push(script);
      if (script.includes("location.pathname")) return "true";
      if (script.includes("watch?v=")) return JSON.stringify("watch?v=abc_123");
      if (script.includes("signedIn")) return JSON.stringify(fake.page);
      return "true";
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("@/lib/desktopOs", () => ({ desktopOs: () => "windows" }));
vi.mock("@/lib/openExternal", () => ({ openInBuiltInBrowser: () => {} }));
vi.stubGlobal("Audio", class extends EventTarget {
  src = "";
  paused = true;
  volume = 1;
  async play() { this.paused = false; this.dispatchEvent(new Event("play")); }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  removeAttribute() {}
});

const { runMusic } = await import("../tool");
const { handleMusicMcp } = await import("@/lib/musicMcp");
const { __musicForTests: store, connectYouTube, findLocalTrack, nowPlaying } = await import("@/lib/music/player");

const track = (title: string, artist: string | null = null) => ({ path: `C:/m/${title}.mp3`, title, artist, album: null, duration: 100 });

beforeEach(() => {
  store.reset();
  localStorage.clear();
  fake.searched = [];
  fake.scripts = [];
});

describe("Music tool", () => {
  it("won't use YouTube Music before the user connects it", async () => {
    const out = await runMusic({ action: "play", query: "Nosotros", service: "youtube_music" });
    expect(out.ok).toBe(false);
    expect(out.text).toContain("Settings > Music");
    expect(fake.searched).toEqual([]);
  });

  it("searches YouTube Music and answers with what is really playing", async () => {
    await connectYouTube();
    const out = await runMusic({ action: "play", query: "Anuel AA Nosotros" });
    expect(out).toEqual({ ok: true, text: 'Playing "Nosotros" by Anuel AA on YouTube Music.' });
    expect(fake.searched).toContain("https://music.youtube.com/search?q=Anuel%20AA%20Nosotros");
    expect(fake.searched).toContain("https://music.youtube.com/watch?v=abc_123");
    expect(nowPlaying(store.get())?.source).toBe("youtube");
  });

  it("falls back to the music folder when no service is connected", async () => {
    store.patch({ folder: "C:/m", tracks: [track("Canción Única", "Ñandú")] });
    const out = await runMusic({ action: "play", query: "cancion nandu" });
    expect(out).toEqual({ ok: true, text: 'Playing "Canción Única" by Ñandú from the music folder.' });
  });

  it("says what to do when there is nowhere to play from", async () => {
    const out = await runMusic({ action: "play", query: "algo" });
    expect(out.ok).toBe(false);
    expect(out.text).toContain("Settings > Music");
  });

  it("needs what to search for", async () => {
    expect((await runMusic({ action: "play" })).ok).toBe(false);
  });

  it("sets one volume for its sources, also in the open page", async () => {
    await connectYouTube();
    const out = await runMusic({ action: "set_volume", volume: 35 });
    expect(out.ok).toBe(true);
    expect(store.get().volume).toBe(0.35);
    await vi.waitFor(() => expect(fake.scripts.some((s) => s.includes("p.setVolume(35)"))).toBe(true));
  });

  it("mutes and unmutes", async () => {
    await connectYouTube();
    expect((await runMusic({ action: "mute" })).ok).toBe(true);
    expect(store.get().muted).toBe(true);
    expect(fake.scripts.some((s) => s.includes("p.mute()"))).toBe(true);
    expect((await runMusic({ action: "status" })).text).toContain("(muted)");
    await runMusic({ action: "unmute" });
    expect(store.get().muted).toBe(false);
    expect(fake.scripts.some((s) => s.includes("p.unMute()"))).toBe(true);
  });

  it("reports what is playing and what is connected", async () => {
    const out = await runMusic({ action: "status" });
    expect(out.text).toContain("Nothing is playing.");
    expect(out.text).toContain("YouTube Music not connected");
  });

  it("refuses to pause when nothing plays", async () => {
    expect((await runMusic({ action: "pause" })).ok).toBe(false);
  });

  it("matches local songs by all the words, ignoring accents and case", () => {
    const tracks = [track("Otra"), track("Noche en calma", "Sesiones")];
    expect(findLocalTrack(tracks, "CALMA sesiones")).toBe(1);
    expect(findLocalTrack(tracks, "calma otra")).toBe(-1);
    expect(findLocalTrack(tracks, "  ")).toBe(-1);
  });

  it("is offered to CLI agents over MCP", async () => {
    const list = await handleMusicMcp({ id: 1, method: "tools/list" });
    const tools = (list.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["music"]);
    const call = await handleMusicMcp({ id: 2, method: "tools/call", params: { name: "music", arguments: { action: "status" } } });
    expect((call.result as { isError?: boolean }).isError).toBeUndefined();
    const bad = await handleMusicMcp({ id: 3, method: "tools/call", params: { name: "music", arguments: { action: "dance" } } });
    expect((bad.result as { isError?: boolean }).isError).toBe(true);
  });
});
