// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fake = vi.hoisted(() => ({ search: vi.fn(), playSong: vi.fn(), invoke: vi.fn(async (): Promise<unknown> => null) }));
vi.mock("@/lib/ipc", () => ({ invoke: () => fake.invoke() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));
vi.mock("@/lib/desktopOs", () => ({ desktopOs: () => "windows" }));
vi.mock("@/lib/music/youtubeMusic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/music/youtubeMusic")>()),
  youtubeSearch: (query: string) => fake.search(query),
  youtubePlaySong: (id: string) => fake.playSong(id),
}));
vi.stubGlobal("Audio", class extends EventTarget {
  src = "";
  paused = true;
  volume = 1;
  muted = false;
  async play() { this.paused = false; this.dispatchEvent(new Event("play")); }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  removeAttribute() {}
});

const { MusicPlayerBar } = await import("../MusicPlayerBar");
const { __musicForTests: store } = await import("@/lib/music/player");
const { YoutubeMusicError } = await import("@/lib/music/youtubeMusic");
const { getTranslations } = await import("@/lib/i18n");
const t = getTranslations("en-US").music;

const page = { title: "CARITA FELIZ", artist: "Myke Towers", cover: null, signedIn: true, loaded: true, playing: true, position: 1, duration: 200, volume: 0.8, muted: false };
const SONGS = [
  { id: "a1", title: "CARITA FELIZ", subtitle: "Canción • Myke Towers", cover: "https://img/a.jpg" },
  { id: "b2", title: "Carita Feliz :)", subtitle: "Canción • danny polo", cover: null },
];
const track = (title: string, artist: string | null = null) => ({ path: `C:/m/${title}.mp3`, title, artist, album: null, duration: 125 });

async function openSearch() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: t.search })); });
  return screen.getByRole("combobox", { name: t.search }) as HTMLInputElement;
}

async function type(text: string) {
  const input = await openSearch();
  fireEvent.change(input, { target: { value: text } });
  return input;
}

beforeEach(() => {
  store.reset();
  localStorage.clear();
  fake.search.mockReset().mockResolvedValue(SONGS);
  fake.playSong.mockReset().mockResolvedValue(page);
  fake.invoke.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

describe("the title bar's music search", () => {
  it("isn't there with nowhere to search", () => {
    render(<MusicPlayerBar />);
    expect(screen.queryByRole("button", { name: t.search })).toBeNull();
  });

  it("is there with a music folder alone", () => {
    store.patch({ folder: "C:/m" });
    render(<MusicPlayerBar />);
    expect(screen.getByRole("button", { name: t.search })).toBeTruthy();
  });

  it("stays with a song playing, to change it", () => {
    store.patch({ youtubeConnected: true, youtube: page });
    render(<MusicPlayerBar />);
    expect(screen.getByRole("button", { name: t.search })).toBeTruthy();
  });

  it("shows the matches while typing, once the typing pauses", async () => {
    store.patch({ youtubeConnected: true });
    render(<MusicPlayerBar />);
    await type("carita");
    expect(fake.search).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(fake.search).toHaveBeenCalledTimes(1);
    expect(fake.search).toHaveBeenCalledWith("carita");
    expect(screen.getByText("Canción • Myke Towers")).toBeTruthy();
  });

  it("searches once for words typed quickly", async () => {
    store.patch({ youtubeConnected: true });
    render(<MusicPlayerBar />);
    const input = await type("ca");
    fireEvent.change(input, { target: { value: "car" } });
    fireEvent.change(input, { target: { value: "carita" } });
    await waitFor(() => expect(fake.search).toHaveBeenCalled());
    expect(fake.search).toHaveBeenCalledTimes(1);
    expect(fake.search).toHaveBeenCalledWith("carita");
  });

  it("doesn't search for a single letter", async () => {
    store.patch({ youtubeConnected: true });
    render(<MusicPlayerBar />);
    await type("c");
    await new Promise((r) => setTimeout(r, 350));
    expect(fake.search).not.toHaveBeenCalled();
  });

  it("plays the chosen match and closes", async () => {
    store.patch({ youtubeConnected: true });
    render(<MusicPlayerBar />);
    await type("carita");
    const rows = await screen.findAllByRole("option");
    await act(async () => { fireEvent.click(rows[1]); });
    expect(fake.playSong).toHaveBeenCalledWith("b2");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("moves through the matches with the arrows and plays with Enter", async () => {
    store.patch({ youtubeConnected: true });
    render(<MusicPlayerBar />);
    const input = await type("carita");
    await screen.findAllByRole("option");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(fake.playSong).toHaveBeenCalledWith("b2");
  });

  it("finds songs of the folder too, and plays them", async () => {
    store.patch({ youtubeConnected: true, folder: "C:/m", tracks: [track("Otra"), track("Carita triste", "Nadie")] });
    render(<MusicPlayerBar />);
    await type("carita");
    const rows = await waitFor(() => {
      const list = screen.getAllByRole("option");
      expect(list).toHaveLength(3);
      return list;
    });
    expect(rows[2].textContent).toContain("Carita triste");
    expect(rows[2].textContent).toContain("2:05");
    await act(async () => { fireEvent.click(rows[2]); });
    expect(store.get().index).toBe(1);
    expect(fake.playSong).not.toHaveBeenCalled();
  });

  it("doesn't ask YouTube Music when it isn't connected", async () => {
    store.patch({ folder: "C:/m", tracks: [track("Carita triste")] });
    render(<MusicPlayerBar />);
    await type("carita");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 350));
    expect(fake.search).not.toHaveBeenCalled();
  });

  it("says when nothing matches", async () => {
    store.patch({ youtubeConnected: true });
    fake.search.mockResolvedValue([]);
    render(<MusicPlayerBar />);
    await type("asdfgh");
    expect(await screen.findByText(t.noResults)).toBeTruthy();
  });

  it("says when the search failed", async () => {
    store.patch({ youtubeConnected: true });
    fake.search.mockRejectedValue(new YoutubeMusicError("search_failed"));
    render(<MusicPlayerBar />);
    await type("carita");
    expect((await screen.findByRole("alert")).textContent).toBe(t.searchFailed);
  });

  it("stays open when a song doesn't start", async () => {
    store.patch({ youtubeConnected: true });
    fake.playSong.mockRejectedValue(new YoutubeMusicError("not_started"));
    render(<MusicPlayerBar />);
    await type("carita");
    const rows = await screen.findAllByRole("option");
    await act(async () => { fireEvent.click(rows[0]); });
    expect(screen.getByRole("alert").textContent).toBe(t.notStarted);
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("clears what was typed", async () => {
    store.patch({ youtubeConnected: true });
    render(<MusicPlayerBar />);
    const input = await type("carita");
    fireEvent.click(screen.getByRole("button", { name: t.clear }));
    expect(input.value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
