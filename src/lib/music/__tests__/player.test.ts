// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null),
  opened: [] as string[],
}));
vi.mock("@/lib/ipc", () => ({ invoke: (cmd: string, args?: unknown) => fake.invoke(cmd, args) }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("@/lib/desktopOs", () => ({ desktopOs: () => "windows" }));
vi.mock("@/lib/openExternal", () => ({ openInBuiltInBrowser: (url: string) => fake.opened.push(url) }));

/** An `<audio>` jsdom can't play: it only records what it is told and fires what a browser would. */
class FakeAudio extends EventTarget {
  static last: FakeAudio;
  src = "";
  paused = true;
  currentTime = 0;
  volume = 1;
  preload = "";
  duration = Number.NaN;
  failNext = false;
  constructor() {
    super();
    FakeAudio.last = this;
  }
  async play() {
    if (this.failNext) throw Object.assign(new Error("no"), { name: "NotSupportedError" });
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
}
vi.stubGlobal("Audio", FakeAudio);

const { __musicForTests: store, chooseFolder, connectYouTube, disconnectYouTube, formatTime, next, nowPlaying, playTrack, previous, setMuted, setSystemEnabled, setVolume, signInToYouTube, toggle, toggleMuted } = await import("../player");
type System = NonNullable<ReturnType<typeof store.get>["system"]>;

const track = (n: number) => ({ path: `C:/m/${n}.mp3`, title: `Canción ${n}`, artist: "Artista", album: null, duration: 100 });
const TRACKS = [track(1), track(2), track(3)];
const youtube: System = { appId: "msedgewebview2.exe", inApp: true, title: "Tema de YouTube", artist: "Banda", album: null, playing: true, position: 10, duration: 200, canToggle: true, canNext: true, canPrevious: true };
const spotify: System = { ...youtube, appId: "Spotify.exe", inApp: false, title: "Tema de Spotify" };

const commands = () => fake.invoke.mock.calls.map((c) => c[0]);
const pageScripts = () => fake.invoke.mock.calls.filter((c) => c[0] === "music_page_run").map((c) => (c[1] as { script: string }).script);

beforeEach(() => {
  store.reset();
  localStorage.clear();
  fake.invoke.mockReset().mockResolvedValue(null);
  fake.opened = [];
});

describe("what the player shows", () => {
  it("shows nothing with no music, so the title bar stays as it is", () => {
    expect(nowPlaying(store.get())).toBeNull();
  });

  it("prefers what is sounding, then the song loaded here", () => {
    store.patch({ tracks: TRACKS, index: 0, systemEnabled: true, system: spotify });
    expect(nowPlaying(store.get())?.title).toBe("Tema de Spotify");

    store.patch({ localPlaying: true });
    expect(nowPlaying(store.get())?.title).toBe("Canción 1");

    store.patch({ localPlaying: false, system: { ...spotify, playing: false } });
    expect(nowPlaying(store.get())?.title).toBe("Canción 1");
  });

  it("doesn't take the player's own audio for another source", () => {
    store.patch({ tracks: TRACKS, index: 0, systemEnabled: true, system: { ...youtube, title: "Canción 1" } });
    expect(nowPlaying(store.get())?.source).toBe("local");
  });

  it("shows YouTube Music in the built-in browser without naming an app", () => {
    store.patch({ systemEnabled: true, system: youtube });
    expect(nowPlaying(store.get())).toMatchObject({ source: "system", title: "Tema de YouTube", appId: null });
  });

  it("names the other app a song plays in", () => {
    store.patch({ systemEnabled: true, system: spotify });
    expect(nowPlaying(store.get())?.appId).toBe("Spotify.exe");
  });

  it("formats times", () => {
    expect(formatTime(84)).toBe("1:24");
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(Number.NaN)).toBe("0:00");
  });
});

describe("the songs of a folder", () => {
  it("asks permission for the one song, then plays it", async () => {
    store.patch({ tracks: TRACKS });
    await playTrack(1);
    expect(fake.invoke).toHaveBeenCalledWith("music_allow_track", { path: "C:/m/2.mp3" });
    expect(FakeAudio.last.src).toBe("asset://C:/m/2.mp3");
    expect(store.get()).toMatchObject({ index: 1, localPlaying: true, playFailed: false });
  });

  it("goes on to the next song, and stops after the last", async () => {
    store.patch({ tracks: TRACKS });
    await playTrack(1);
    FakeAudio.last.dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(store.get().index).toBe(2));
    await vi.waitFor(() => expect(FakeAudio.last.src).toBe("asset://C:/m/3.mp3"));

    FakeAudio.last.pause();
    FakeAudio.last.dispatchEvent(new Event("ended"));
    expect(store.get()).toMatchObject({ index: 2, localPlaying: false, localPosition: 0 });
  });

  it("restarts the song on previous once it has played a while", async () => {
    store.patch({ tracks: TRACKS });
    await playTrack(1);
    FakeAudio.last.currentTime = 30;
    store.patch({ localPosition: 30 });
    previous();
    expect(FakeAudio.last.currentTime).toBe(0);
    expect(store.get().index).toBe(1);

    store.patch({ localPosition: 1 });
    previous();
    await vi.waitFor(() => expect(store.get().index).toBe(0));
  });

  it("says so when a song can't play", async () => {
    store.patch({ tracks: TRACKS, index: 0 });
    toggle();
    await vi.waitFor(() => expect(FakeAudio.last).toBeTruthy());
    FakeAudio.last.failNext = true;
    await playTrack(2);
    expect(store.get()).toMatchObject({ localPlaying: false, playFailed: true });
  });

  it("stops the old song when a new folder replaces the list", async () => {
    store.patch({ tracks: TRACKS });
    await playTrack(0);
    fake.invoke.mockResolvedValue({ tracks: [track(9)], truncated: false });
    await chooseFolder("C:/otra");
    expect(store.get()).toMatchObject({ folder: "C:/otra", index: -1, localPlaying: false, scanning: false });
    expect(store.get().tracks[0].title).toBe("Canción 9");
    expect(FakeAudio.last.src).toBe("");
  });

  it("reports a folder it can't read", async () => {
    fake.invoke.mockRejectedValue(new Error("no"));
    await chooseFolder("C:/rota");
    expect(store.get()).toMatchObject({ scanning: false, scanFailed: true, tracks: [] });
  });
});

describe("other apps' music", () => {
  it("sends the buttons to the app that is playing", async () => {
    store.patch({ systemEnabled: true, system: spotify });
    toggle();
    next();
    previous();
    const actions = fake.invoke.mock.calls.filter((c) => c[0] === "music_system_control").map((c) => c[1]);
    expect(actions).toEqual([{ action: "toggle" }, { action: "next" }, { action: "previous" }]);
  });

  it("keeps showing the song through the gap before the next, then lets go", async () => {
    let report: System | null = spotify;
    fake.invoke.mockImplementation(async (cmd: string) => (cmd === "music_system_state" ? report : null));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      setSystemEnabled(true);
      await vi.waitFor(() => expect(store.get().system?.title).toBe("Tema de Spotify"));

      report = null;
      now.mockReturnValue(1_002_000);
      await store.pollSystem();
      expect(nowPlaying(store.get())?.title).toBe("Tema de Spotify");

      report = { ...spotify, title: "La siguiente" };
      await store.pollSystem();
      expect(nowPlaying(store.get())?.title).toBe("La siguiente");

      // The app was closed: nothing comes after the gap.
      report = null;
      now.mockReturnValue(1_010_000);
      await store.pollSystem();
      expect(nowPlaying(store.get())).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("reads nothing from other apps until it's turned on", async () => {
    await store.pollSystem();
    expect(commands()).not.toContain("music_system_state");
  });

  it("forgets what it read when it's turned off", async () => {
    fake.invoke.mockImplementation(async (cmd: string) => (cmd === "music_system_state" ? spotify : null));
    setSystemEnabled(true);
    await vi.waitFor(() => expect(store.get().system?.title).toBe("Tema de Spotify"));
    setSystemEnabled(false);
    expect(store.get().system).toBeNull();
    expect(nowPlaying(store.get())).toBeNull();
  });

});

describe("YouTube Music", () => {
  const page = { title: "Nosotros", artist: "Anuel AA", cover: "https://img/x.jpg", signedIn: true, loaded: true, playing: true, position: 92, duration: 240, volume: 0.8, muted: false };
  const answerPage = (data: unknown) => fake.invoke.mockImplementation(async (cmd: string) => (cmd === "music_page_run" ? JSON.stringify(data) : null));

  it("opens its page out of the window, never in the visible browser", async () => {
    answerPage(page);
    await connectYouTube();
    const open = fake.invoke.mock.calls.find((c) => c[0] === "preview_open")?.[1] as { x: number; y: number; hidden: boolean };
    expect(open.x).toBeLessThan(0);
    expect(open.y).toBeLessThan(0);
    expect(open.hidden).toBe(false);
    expect(fake.opened).toEqual([]);
  });

  it("shows the song with its picture, and the volume can be changed", async () => {
    answerPage(page);
    await connectYouTube();
    expect(nowPlaying(store.get())).toMatchObject({ source: "youtube", title: "Nosotros", position: 92, adjustable: true });
    expect(store.get().cover).toBe("https://img/x.jpg");
  });

  it("doesn't count its own session in Windows as another app", async () => {
    answerPage(page);
    await connectYouTube();
    store.patch({ systemEnabled: true, system: { ...youtube, title: "Nosotros" } });
    expect(nowPlaying(store.get())?.source).toBe("youtube");
  });

  it("corrects a page whose volume drifted from the player's", async () => {
    answerPage({ ...page, volume: 1 });
    await connectYouTube();
    await vi.waitFor(() => expect(pageScripts().some((s) => s.includes("p.setVolume(80)"))).toBe(true));
  });

  it("doesn't fight the user while they move the volume", async () => {
    answerPage({ ...page, volume: 0.8 });
    await connectYouTube();
    setVolume(0.3);
    await vi.waitFor(() => expect(pageScripts().some((s) => s.includes("p.setVolume(30)"))).toBe(true));
    // A read that still carries the old volume arrives right after the change.
    fake.invoke.mockClear();
    answerPage({ ...page, volume: 0.8 });
    await store.pollYoutube();
    expect(pageScripts().some((s) => s.includes("setVolume"))).toBe(false);
    expect(store.get().volume).toBe(0.3);
  });

  it("sends only the latest volume while one is on its way", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const sent: string[] = [];
    fake.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "music_page_run") return null;
      const { script } = args as { script: string };
      const level = /p\.setVolume\((\d+)\)/.exec(script)?.[1];
      if (level) {
        sent.push(level);
        await gate;
      }
      return JSON.stringify(page);
    });
    await connectYouTube();
    setVolume(0.1);
    setVolume(0.2);
    setVolume(0.3);
    release();
    await vi.waitFor(() => expect(sent.at(-1)).toBe("30"));
    expect(sent).not.toContain("20");
  });

  it("mutes every source, and moving the volume takes the mute off", async () => {
    answerPage(page);
    await connectYouTube();
    toggleMuted();
    expect(store.get().muted).toBe(true);
    expect(pageScripts().some((s) => s.includes("p.mute()"))).toBe(true);
    setVolume(0.4);
    expect(store.get().muted).toBe(false);
    expect(pageScripts().some((s) => s.includes("p.unMute()"))).toBe(true);
  });

  it("unmuting something at zero brings some sound back", () => {
    setVolume(0);
    setMuted(true);
    setMuted(false);
    expect(store.get()).toMatchObject({ muted: false, volume: 0.5 });
  });

  it("closes its page and forgets the song when disconnected", async () => {
    answerPage(page);
    await connectYouTube();
    disconnectYouTube();
    expect(commands()).toContain("preview_close");
    expect(nowPlaying(store.get())).toBeNull();
    expect(store.get().youtubeConnected).toBe(false);
  });

  it("doesn't vanish while the page moves on to the next song", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      answerPage(page);
      await connectYouTube();

      answerPage({ ...page, title: null, loaded: false, playing: false });
      now.mockReturnValue(2_002_000);
      await store.pollYoutube();
      expect(nowPlaying(store.get())?.title).toBe("Nosotros");

      answerPage({ ...page, title: "La siguiente" });
      await store.pollYoutube();
      expect(nowPlaying(store.get())?.title).toBe("La siguiente");
    } finally {
      now.mockRestore();
    }
  });

  it("uses the real page only to sign in", () => {
    signInToYouTube();
    expect(fake.opened).toEqual(["https://music.youtube.com/"]);
  });

  it("other apps' volume can't be changed", () => {
    store.patch({ systemEnabled: true, system: spotify });
    expect(nowPlaying(store.get())?.adjustable).toBe(false);
  });
});

describe("the cover", () => {
  it("is read when the song changes, not on every tick", async () => {
    fake.invoke.mockImplementation(async (cmd: string) => (cmd === "music_track_cover" ? "data:image/png;base64,AA==" : null));
    store.patch({ tracks: TRACKS });
    await playTrack(0);
    await vi.waitFor(() => expect(store.get().cover).toBe("data:image/png;base64,AA=="));
    store.patch({ localPosition: 5 });
    store.patch({ localPosition: 6 });
    expect(commands().filter((c) => c === "music_track_cover")).toHaveLength(1);
  });
});
