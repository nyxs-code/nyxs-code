import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { addressInQuery, mcpToolText, pageMetadata, parseBingResults, parseExaResults, parseParallelResults, unwrapBingUrl } from "./web";

describe("keyless search endpoints", () => {
  const exaText =
    "Title: Rivera, Ana | Example Legal\nURL: https://www.example-legal.com/team/ana-rivera/\nPublished: N/A\nAuthor: N/A\nHighlights:\nAna Rivera is a contracts\n\nand employment attorney.\n\n" +
    "Title: Example Bar | Find A Lawyer\n |  Ana Rivera\nURL: https://bar.example.org/attorneys/member.cfm?id=12345\nPublished: 2017-09-19T00:00:00.000Z\nAuthor: N/A\nHighlights:\nAttorney at law.";

  it("reads Exa's event stream and its result blocks", () => {
    const stream = `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: exaText }] }, jsonrpc: "2.0", id: 1 })}\n\n`;
    expect(parseExaResults(mcpToolText(stream)!)).toEqual([
      {
        title: "Rivera, Ana | Example Legal",
        url: "https://www.example-legal.com/team/ana-rivera/",
        snippet: "Ana Rivera is a contracts and employment attorney.",
      },
      { title: "Example Bar | Find A Lawyer | Ana Rivera", url: "https://bar.example.org/attorneys/member.cfm?id=12345", snippet: "2017-09-19 · Attorney at law." },
    ]);
  });

  it("reads Parallel's JSON answer", () => {
    const answer = JSON.stringify({
      results: [
        { url: "https://bar.example.org/directories/profile?num=54321", title: "Example Bar Member Profile", publish_date: null, excerpts: ["Ana Rivera", "Admitted: 09/19/2017"] },
        { url: "https://example.com/no-title", excerpts: ["x"] },
      ],
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: answer }] } });
    expect(parseParallelResults(mcpToolText(body)!)).toEqual([
      { title: "Example Bar Member Profile", url: "https://bar.example.org/directories/profile?num=54321", snippet: "Ana Rivera … Admitted: 09/19/2017" },
    ]);
  });

  it("treats an error answer as no answer", () => {
    expect(mcpToolText(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Too many requests" } }))).toBeNull();
    expect(mcpToolText(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "limit" }] } }))).toBeNull();
  });
});
import { searchableTitle } from "./WebSearch/tool";

describe("searching for a page's title", () => {
  it("drops the site's own name and keeps the rest", () => {
    expect(searchableTitle("Serde - GitHub", "https://github.com/serde-rs/serde")).toBe("Serde");
    expect(searchableTitle("KIMI K3.1? - YouTube", "https://www.youtube.com/watch?v=x")).toBe("KIMI K3.1?");
    expect(searchableTitle("KIMI K3.1? - Vibecodeando - Dia 23 #codex", "https://www.youtube.com/watch?v=x")).toBe(
      "KIMI K3.1? - Vibecodeando - Dia 23 #codex",
    );
  });

  it("is empty when the page is only the site (a YouTube id that isn't a video)", () => {
    expect(searchableTitle("- YouTube", "https://www.youtube.com/watch?v=JavaScripts")).toBe("");
  });
});

describe("a search query that is a web address", () => {
  const url = (q: string) => addressInQuery(q)?.url ?? null;

  it("is taken as an address with a scheme or a path, alone or among words", () => {
    expect(url("https://www.youtube.com/watch?v=ZPjQAKOkLrA")).toBe("https://www.youtube.com/watch?v=ZPjQAKOkLrA");
    expect(url("youtube.com/watch?v=ZPjQAKOkLrA")).toBe("https://youtube.com/watch?v=ZPjQAKOkLrA");
    expect(url(" <https://docs.rs/serde> ")).toBe("https://docs.rs/serde");
    expect(url("what is (youtube.com/shorts/abc), explained")).toBe("https://youtube.com/shorts/abc");
    expect(addressInQuery("https://docs.rs/serde")?.guessed).toBe(false);
  });

  it("guesses a YouTube video from its id next to the word youtube", () => {
    expect(addressInQuery("youtube ZPjQAKOkLrA")).toEqual({ url: "https://www.youtube.com/watch?v=ZPjQAKOkLrA", guessed: true });
    expect(url("youtu.be dQw4w9WgXcQ video")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(url("ZPjQAKOkLrA")).toBeNull();
    expect(url("youtube Programming tutorial")).toBeNull();
  });

  it("leaves words and bare domains to the search engine", () => {
    expect(url("github.com")).toBeNull();
    expect(url("React 19 release notes")).toBeNull();
  });
});

describe("what a page says about itself", () => {
  it("reads the title and description from the head", () => {
    const html = `<html><head><title>Old title</title><meta property="og:title" content="Serde &amp; friends">
      <meta name="description" content='A framework for serializing "Rust" data'></head><body><script>x</script></body></html>`;
    expect(pageMetadata(html, "https://serde.rs/")).toEqual({ title: "Serde & friends", description: 'A framework for serializing "Rust" data' });
  });

  it("takes a YouTube video's full description from the page's data", () => {
    const html = `<title>KIMI K3.1 ES UNA DECEPCION? - YouTube</title><meta name="description" content="Construyendo sistemas...">
      <script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"Construyendo sistemas reales con IA.\\n\\nDiscord: https:\\/\\/discord.gg\\/x \\"live\\""}};</script>`;
    expect(pageMetadata(html, "https://www.youtube.com/watch?v=ZPjQAKOkLrA")).toEqual({
      title: "KIMI K3.1 ES UNA DECEPCION? - YouTube",
      description: 'Construyendo sistemas reales con IA.\n\nDiscord: https://discord.gg/x "live"',
    });
  });
});

// One result as Bing serves it: the address behind its click tracker, a date before the snippet.
const BING_RESULT = `<li class="b_algo" data-id iid=SERP.5342><div class="b_tpcn"><a class="tilk" href="https://www.bing.com/ck/a?!&amp;&amp;p=f8c8&amp;u=a1aHR0cHM6Ly9naXRodWIuY29tL3RhdXJpLWFwcHMvdGF1cmkvaXNzdWVzLzEwMDc5&amp;ntb=1"><div class="tptt">github.com</div></a></div><h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=f8c8&amp;u=a1aHR0cHM6Ly9naXRodWIuY29tL3RhdXJpLWFwcHMvdGF1cmkvaXNzdWVzLzEwMDc5&amp;ntb=1" h="ID=SERP,5144.2">[feat] [v2] How to create a <strong>child web view</strong> #10079 - GitHub</a></h2><div class="b_caption"><p class="b_lineclamp2"><span class="news_dt">Jun 18, 2024</span>&nbsp;&#0183;&#32;Is that right? Also, I found add_child.</p></div></li>`;

describe("Bing results", () => {
  it("takes the title, the real address and the snippet", () => {
    expect(parseBingResults(`<ol id="b_results">${BING_RESULT}${BING_RESULT}</ol>`)).toEqual([
      {
        title: "[feat] [v2] How to create a child web view #10079 - GitHub",
        url: "https://github.com/tauri-apps/tauri/issues/10079",
        snippet: "Jun 18, 2024 · Is that right? Also, I found add_child.",
      },
      expect.objectContaining({ url: "https://github.com/tauri-apps/tauri/issues/10079" }),
    ]);
  });

  it("keeps direct links and decodes non-ASCII addresses", () => {
    expect(unwrapBingUrl("https://example.com/a?b=1&amp;c=2")).toBe("https://example.com/a?b=1&c=2");
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode("https://es.wikipedia.org/wiki/Café")))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(unwrapBingUrl(`https://www.bing.com/ck/a?!&u=a1${encoded}&ntb=1`)).toBe("https://es.wikipedia.org/wiki/Café");
  });

  it("finds nothing on a page without results", () => {
    expect(parseBingResults("<html><body>Captcha</body></html>")).toEqual([]);
  });
});
