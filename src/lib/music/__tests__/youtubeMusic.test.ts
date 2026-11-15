// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn() }));

const { FIRST_RESULT_SCRIPT, READ_SCRIPT, searchScript, searchUrl, watchUrl } = await import("../youtubeMusic");

/** Runs one of the page's scripts on a document, as the webview would. */
const inPage = <T,>(html: string, script: string): T => {
  document.body.innerHTML = html;
  return (0, eval)(script) as T;
};

describe("the YouTube Music page", () => {
  it("takes the first song of the results, past artists and albums", () => {
    const html = `<ytmusic-search-page>
      <a href="channel/UC1">Artista</a>
      <a href="browse/MPREb">Álbum</a>
      <a href="watch?v=XWLQKNvCepM">Affection</a>
      <a href="watch?v=otro">Otra</a>
    </ytmusic-search-page>`;
    expect(inPage(html, FIRST_RESULT_SCRIPT)).toBe("watch?v=XWLQKNvCepM");
  });

  it("finds no song in a page of results without any", () => {
    expect(inPage(`<ytmusic-search-page><a href="channel/UC1">Artista</a></ytmusic-search-page>`, FIRST_RESULT_SCRIPT)).toBeNull();
  });

  it("reads a page with nothing loaded", () => {
    const page = inPage<{ loaded: boolean; playing: boolean; signedIn: boolean }>("<main></main>", READ_SCRIPT);
    expect(page).toMatchObject({ loaded: false, playing: false, signedIn: true });
  });

  it("notices when no account is signed in", () => {
    expect(inPage<{ signedIn: boolean }>(`<a class="sign-in-link" href="#">Acceder</a>`, READ_SCRIPT).signedIn).toBe(false);
  });

  describe("searching without leaving the page", () => {
    const row = (id: string | null, title: string, subtitle: string, url?: string) => ({
      musicResponsiveListItemRenderer: {
        ...(id ? { playlistItemData: { videoId: id } } : {}),
        thumbnail: url ? { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url }, { url: `${url}-big` }] } } } : undefined,
        flexColumns: [
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: subtitle.split(" • ")[0] }, { text: " • " }, { text: subtitle.split(" • ")[1] }] } } },
        ],
      },
    });
    const w = window as unknown as Record<string, unknown>;

    function stubSite(answer: () => Promise<unknown>) {
      const config: Record<string, unknown> = { INNERTUBE_CONTEXT: { client: {} }, INNERTUBE_API_KEY: "k" };
      w.ytcfg = { get: (name: string) => config[name] };
      const fetchMock = vi.fn(answer);
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    const answer = async () => {
      await vi.waitFor(() => expect((w.__nyxsMusicSearch as { done: boolean }).done).toBe(true));
      return w.__nyxsMusicSearch as { id: number; failed: boolean; results: { id: string; title: string; subtitle: string; cover: string | null }[] };
    };

    it("asks the site and keeps songs and videos, each once", async () => {
      const fetchMock = stubSite(async () => ({
        ok: true,
        json: async () => ({ contents: [row("a1", "CARITA FELIZ", "Canción • Myke Towers", "https://img/a"), row(null, "Un artista", "Artista • Nadie"), [row("a1", "CARITA FELIZ", "Canción • Myke Towers")], { deep: row("b2", "Otra", "Vídeo • Alguien") }] }),
      }));
      expect((0, eval)(searchScript(7, 'carita "feliz"'))).toBe(true);
      const out = await answer();
      expect(out.id).toBe(7);
      expect(out.results).toEqual([
        { id: "a1", title: "CARITA FELIZ", subtitle: "Canción • Myke Towers", cover: "https://img/a" },
        { id: "b2", title: "Otra", subtitle: "Vídeo • Alguien", cover: null },
      ]);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
      expect(url).toContain("/youtubei/v1/search");
      expect(JSON.parse(init.body).query).toBe('carita "feliz"');
    });

    it("keeps the list short", async () => {
      stubSite(async () => ({ ok: true, json: async () => ({ contents: Array.from({ length: 20 }, (_, i) => row(`id${i}`, `T${i}`, "Canción • X")) }) }));
      (0, eval)(searchScript(8, "x"));
      expect((await answer()).results).toHaveLength(8);
    });

    it("reports a request that fails", async () => {
      stubSite(async () => ({ ok: false, status: 500, json: async () => ({}) }));
      (0, eval)(searchScript(9, "x"));
      expect((await answer()).failed).toBe(true);
    });

    it("waits for the site's config before asking", () => {
      w.ytcfg = undefined;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      expect((0, eval)(searchScript(10, "x"))).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("builds addresses only from the song's id", () => {
    expect(watchUrl("watch?v=XWLQKNvCepM&list=RD1")).toBe("https://music.youtube.com/watch?v=XWLQKNvCepM");
    expect(watchUrl("https://evil.example/?v=abc")).toBe("https://music.youtube.com/watch?v=abc");
    expect(watchUrl("browse/MPREb")).toBeNull();
    expect(watchUrl(null)).toBeNull();
    expect(searchUrl("ñu & co")).toBe("https://music.youtube.com/search?q=%C3%B1u%20%26%20co");
  });
});
