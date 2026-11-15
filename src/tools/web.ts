import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isPrivateNetworkUrl } from "@/lib/permissions";
import { hostOf } from "@/lib/toolDetail";

export const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** How long one page read (request and body) may take. The HTTP plugin has no deadline of its
 *  own, so a server that keeps the connection open left the tool row on "Working…" forever. */
export const WEB_TIMEOUT_MS = 30_000;

/** Runs `work` with a signal that aborts after `ms` or when `outer` aborts, and rejects right
 *  then even if `work` ignores the signal (a stalled body read doesn't always see it). */
export function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number = WEB_TIMEOUT_MS, outer?: AbortSignal): Promise<T> {
  if (outer?.aborted) return Promise.reject(new Error("cancelled"));
  const ctl = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error) => {
      done();
      ctl.abort(err);
      reject(err);
    };
    const onAbort = () => fail(new Error("cancelled"));
    const timer = setTimeout(() => fail(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    outer?.addEventListener("abort", onAbort, { once: true });
    work(ctl.signal).then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(e);
      },
    );
  });
}

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|ul|ol|table)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeHtmlEntities(s);
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToInline(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export interface PageMeta {
  title: string;
  description: string;
}

const MAX_META_DESCRIPTION = 2000;

/** What a page says about itself in its <head>, plus a YouTube video's own description. Text
 *  extraction loses both: it drops scripts, and many pages build their body with them. */
export function pageMetadata(html: string, url: string): PageMeta {
  const meta = (attr: string, name: string) => {
    const tag = new RegExp(`<meta\\b[^>]*\\b${attr}=["']${name}["'][^>]*>`, "i").exec(html)?.[0];
    const m = tag && /\bcontent="([^"]*)"|\bcontent='([^']*)'/i.exec(tag);
    return m ? htmlToInline(m[1] ?? m[2] ?? "") : "";
  };
  const title = meta("property", "og:title") || htmlToInline(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  let description = "";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(hostOf(url))) {
    const raw = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html)?.[1];
    try {
      if (raw) description = (JSON.parse(`"${raw}"`) as string).trim();
    } catch {
      // Not valid JSON: the meta description below still has its start.
    }
  }
  description ||= meta("property", "og:description") || meta("name", "description");
  if (description.length > MAX_META_DESCRIPTION) description = description.slice(0, MAX_META_DESCRIPTION) + "…";
  return { title, description };
}

export function formatPageMeta({ title, description }: PageMeta): string {
  return [title && `Title: ${title}`, description && `Description: ${description}`].filter(Boolean).join("\n");
}

/** A YouTube video id: 11 characters with a digit, `-`/`_` or a capital past the first one, so
 *  a plain capitalized word ("Programming") isn't taken for one. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const looksLikeVideoId = (t: string) => YOUTUBE_ID.test(t) && (/[0-9_-]/.test(t) || (/[A-Z]/.test(t.slice(1)) && /[a-z]/.test(t)));

/** A page address in the query (with a scheme or a path), since search engines don't find a
 *  page by its address: they match its words ("https", "youtube") instead. A YouTube video id
 *  next to the word "youtube" counts too, as a `guessed` address. */
export function addressInQuery(query: string): { url: string; guessed: boolean } | null {
  const tokens = query.trim().split(/\s+/).map((t) => t.replace(/^["'<(]+|["'>),.]+$/g, ""));
  for (const t of tokens) {
    const m = /^(https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?$/i.exec(t);
    if (m && (m[1] || m[3])) return { url: m[1] ? t : `https://${t}`, guessed: false };
  }
  if (/\byoutu\.?be\b/i.test(query)) {
    const id = tokens.find(looksLikeVideoId);
    if (id) return { url: `https://www.youtube.com/watch?v=${id}`, guessed: true };
  }
  return null;
}

const MAX_LOOKUP_REDIRECTS = 10;

/** The title and description of the page at `url`, or null when it can't be read. Redirects are
 *  followed one at a time: from a public site into this computer or the local network only when
 *  `allowPrivateHop` says so (the permission gate), since the HTTP client would follow any. Hops
 *  between public sites (a youtu.be link) go on. */
export async function lookUpPage(url: string, signal?: AbortSignal, allowPrivateHop?: (url: string) => Promise<boolean>): Promise<PageMeta | null> {
  let meta: PageMeta | null = null;
  try {
    meta = await withDeadline(async (s) => {
      let current = url;
      for (let hop = 0; hop <= MAX_LOOKUP_REDIRECTS; hop++) {
        const res = await tauriFetch(current, {
          method: "GET",
          headers: { "User-Agent": WEB_USER_AGENT, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
          signal: s,
          maxRedirections: 0,
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!location) return res.ok && /html/i.test(res.headers.get("content-type") ?? "") ? pageMetadata(await res.text(), current) : null;
        const next = new URL(location, current).href;
        if (isPrivateNetworkUrl(next) && !isPrivateNetworkUrl(current) && !(await allowPrivateHop?.(next))) return null;
        current = next;
      }
      return null;
    }, SEARCH_TIMEOUT_MS, signal);
  } catch {
    if (signal?.aborted) return null;
    // Unreachable: YouTube's oEmbed below may still know the video.
  }
  // YouTube sometimes serves a page without the video's details; oEmbed still has its title.
  if (!meta?.title.replace(/[-\s]*YouTube$/i, "").trim() && /(^|\.)(youtube\.com|youtu\.be)$/.test(hostOf(url))) {
    const video = await youTubeOEmbed(url);
    if (video) meta = { title: video, description: meta?.description ?? "" };
  }
  return meta && (meta.title || meta.description) ? meta : null;
}

async function youTubeOEmbed(url: string): Promise<string | null> {
  try {
    const data = await withDeadline(async (signal) => {
      const res = await tauriFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
        method: "GET",
        headers: { "User-Agent": WEB_USER_AGENT, Accept: "application/json" },
        signal,
      });
      return res.ok ? ((await res.json()) as { title?: string; author_name?: string }) : null;
    }, SEARCH_TIMEOUT_MS);
    if (!data) return null;
    if (!data.title) return null;
    return data.author_name ? `${data.title} (by ${data.author_name})` : data.title;
  } catch {
    return null;
  }
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function unwrapDdgUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) return decodeURIComponent(m[1]);
  if (href.startsWith("//")) return "https:" + href;
  return href;
}

export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const anchorRe = /<a\b([^>]*\b(?:result__a|result-link)\b[^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(anchorRe)) {
    const hrefM = /href\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (!hrefM) continue;
    const url = unwrapDdgUrl(hrefM[1]);
    const title = htmlToInline(m[2]);
    if (url && title) out.push({ title, url, snippet: "" });
  }
  const snippetRe = /<(?:a|td)\b[^>]*\b(?:result__snippet|result-snippet)\b[^>]*>([\s\S]*?)<\/(?:a|td)>/gi;
  const snippets = [...html.matchAll(snippetRe)].map((s) => htmlToInline(s[1]));
  for (let i = 0; i < out.length && i < snippets.length; i++) out[i].snippet = snippets[i];
  return out;
}

// Exa and Parallel run search indexes of their own and answer through public MCP endpoints
// that need no key (OpenCode searches through Exa's the same way). Scraping DuckDuckGo or Bing
// gets bot checks or deliberately unrelated results after a few searches from one address.

const SNIPPET_CHARS = 800;
const SEARCH_TIMEOUT_MS = 20_000;

function clip(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > SNIPPET_CHARS ? s.slice(0, SNIPPET_CHARS) + "…" : s;
}

const datePrefix = (date: string | null | undefined) => (date && date !== "N/A" ? `${date.slice(0, 10)} · ` : "");

/** GETs `url` within the search deadline: its body on HTTP 200, otherwise null. */
async function readPage(url: string, headers: Record<string, string>): Promise<string | null> {
  return withDeadline(async (signal) => {
    const res = await tauriFetch(url, { method: "GET", headers, signal });
    return res.status === 200 ? await res.text() : null;
  }, SEARCH_TIMEOUT_MS);
}

/** Calls one tool of a keyless MCP endpoint and returns its text, or null when it fails. The
 *  answer comes as plain JSON or as a server-sent event stream. */
async function callMcpTool(endpoint: string, name: string, args: Record<string, unknown>): Promise<string | null> {
  try {
    return await withDeadline(async (signal) => {
      const res = await tauriFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        signal,
      });
      return res.ok ? mcpToolText(await res.text()) : null;
    }, SEARCH_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export function mcpToolText(body: string): string | null {
  const payloads = body.trimStart().startsWith("{")
    ? [body]
    : body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  for (const p of payloads) {
    try {
      const msg = JSON.parse(p) as { result?: { isError?: boolean; content?: { type?: string; text?: string }[] } };
      if (!msg.result || msg.result.isError) continue;
      const text = msg.result.content?.find((c) => typeof c.text === "string")?.text;
      if (text) return text;
    } catch {
      // A keep-alive or a partial line: the next one may hold the answer.
    }
  }
  return null;
}

/** Exa answers in blocks: "Title: …\nURL: …\nPublished: …\nAuthor: …\nHighlights:\n…". */
export function parseExaResults(text: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of text.split(/\n+(?=Title: )/)) {
    const m = /^Title: ([\s\S]*?)\nURL: (\S+)/.exec(block.trim());
    if (!m) continue;
    const published = /\nPublished: (.*)/.exec(block)?.[1]?.trim();
    const highlights = /\nHighlights:\n?([\s\S]*)$/.exec(block)?.[1] ?? "";
    out.push({ title: clip(m[1]), url: m[2], snippet: datePrefix(published) + clip(highlights) });
  }
  return out;
}

export async function exaSearch(query: string): Promise<SearchResult[]> {
  const text = await callMcpTool("https://mcp.exa.ai/mcp", "web_search_exa", {
    query,
    numResults: 10,
    type: "auto",
    livecrawl: "fallback",
  });
  return text ? parseExaResults(text) : [];
}

interface ParallelAnswer {
  results?: { url?: string; title?: string; publish_date?: string | null; excerpts?: string[] }[];
}

export function parseParallelResults(text: string): SearchResult[] {
  try {
    const data = JSON.parse(text) as ParallelAnswer;
    return (data.results ?? [])
      .filter((r) => r.url && r.title)
      .map((r) => ({ title: clip(r.title!), url: r.url!, snippet: datePrefix(r.publish_date) + clip((r.excerpts ?? []).join(" … ")) }));
  } catch {
    return [];
  }
}

/** Parallel limits its free use per conversation-like session; one id per app run. */
const PARALLEL_SESSION = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/gi, "");

export async function parallelSearch(query: string): Promise<SearchResult[]> {
  const text = await callMcpTool("https://search.parallel.ai/mcp", "web_search", {
    objective: query,
    search_queries: [query],
    session_id: PARALLEL_SESSION,
    model_name: "nyxs",
  });
  return text ? parseParallelResults(text) : [];
}

/** DuckDuckGo answers a burst of searches with a bot check (status 202) for a while; asking
 *  again meanwhile only adds wait to every search, so it rests until then. */
const DDG_REST_MS = 10 * 60_000;
let ddgRestUntil = 0;

export async function duckDuckGoSearch(query: string): Promise<SearchResult[]> {
  if (Date.now() < ddgRestUntil) return [];
  const q = encodeURIComponent(query);
  const attempts: Array<(signal: AbortSignal) => Promise<Response>> = [
    (signal) =>
      tauriFetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          "User-Agent": WEB_USER_AGENT,
          Accept: "text/html",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://duckduckgo.com/",
        },
        body: `q=${q}`,
        signal,
      }),
    (signal) =>
      tauriFetch(`https://lite.duckduckgo.com/lite/?q=${q}`, {
        method: "GET",
        headers: { "User-Agent": WEB_USER_AGENT, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
        signal,
      }),
    (signal) =>
      tauriFetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        method: "GET",
        headers: { "User-Agent": WEB_USER_AGENT, Accept: "text/html" },
        signal,
      }),
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { status, html } = await withDeadline(async (signal) => {
        const res = await attempts[i](signal);
        return { status: res.status, html: res.status === 200 ? await res.text() : "" };
      }, SEARCH_TIMEOUT_MS);
      if (status === 202) {
        ddgRestUntil = Date.now() + DDG_REST_MS;
        return [];
      }
      if (status === 200) {
        const results = parseDuckDuckGoResults(html);
        if (results.length) return results;
      }
    } catch {
      // Ruta caída: probamos la siguiente.
    }
    if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 500));
  }
  return [];
}

/** Bing links go through a click tracker that carries the real address as `u=a1<base64url>`. */
export function unwrapBingUrl(href: string): string {
  const url = decodeHtmlEntities(href);
  const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(url);
  if (!m) return url;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return url;
  }
}

export function parseBingResults(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const link = /<h2[^>]*>\s*<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = unwrapBingUrl(link[1]);
    const title = htmlToInline(link[2]);
    if (!/^https?:\/\//i.test(url) || !title) continue;
    const caption = /class="b_caption"[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({ title, url, snippet: caption ? htmlToInline(caption[1]) : "" });
  }
  return out;
}

export async function bingSearch(query: string): Promise<SearchResult[]> {
  try {
    const html = await readPage(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, {
      "User-Agent": WEB_USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    });
    return html === null ? [] : parseBingResults(html);
  } catch {
    return [];
  }
}

export function parseMojeekResults(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const titleRe = /<a class="title"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(titleRe)) {
    const title = htmlToInline(m[2]);
    if (title) out.push({ title, url: m[1], snippet: "" });
  }
  return out;
}

export async function mojeekSearch(query: string): Promise<SearchResult[]> {
  try {
    const html = await readPage(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {
      "User-Agent": WEB_USER_AGENT,
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
    });
    return html === null ? [] : parseMojeekResults(html);
  } catch {
    return [];
  }
}

export function looksLikeNewsQuery(q: string): boolean {
  return (
    /\b(news|latest|today|recent|breaking|update|announc\w*|noticias?|hoy|[uú]ltim[ao]s?|recient\w*|actualidad|novedades?|anunci\w*)\b/i.test(q) ||
    /\b20(2[3-9]|3\d)\b/.test(q) ||
    /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.test(q)
  );
}

export function parseGoogleNewsRss(xml: string): SearchResult[] {
  const strip = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "");
  const items: Array<{ r: SearchResult; ts: number }> = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = htmlToInline(strip(/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? ""));
    const url = strip(/<link>([\s\S]*?)<\/link>/i.exec(block)?.[1] ?? "").trim();
    if (!title || !url) continue;
    const dateStr = strip(/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(block)?.[1] ?? "").trim();
    const source = htmlToInline(strip(/<source[^>]*>([\s\S]*?)<\/source>/i.exec(block)?.[1] ?? ""));
    const snippet = [dateStr, source].filter(Boolean).join(" · ");
    const ts = dateStr ? Date.parse(dateStr) : NaN;
    items.push({ r: { title, url, snippet }, ts: Number.isNaN(ts) ? 0 : ts });
  }
  items.sort((a, b) => b.ts - a.ts);
  return items.map((i) => i.r);
}

export async function googleNewsSearch(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const xml = await readPage(url, { "User-Agent": WEB_USER_AGENT, Accept: "application/rss+xml,text/xml,*/*" });
    return xml === null ? [] : parseGoogleNewsRss(xml);
  } catch {
    return [];
  }
}

export async function searchTheWeb(query: string): Promise<SearchResult[]> {
  const wantsRecent = looksLikeNewsQuery(query);
  const [news, exa] = await Promise.all([
    wantsRecent ? googleNewsSearch(query) : Promise.resolve([] as SearchResult[]),
    exaSearch(query),
  ]);
  let web = exa;
  for (const next of [parallelSearch, duckDuckGoSearch, bingSearch, mojeekSearch]) {
    if (web.length) break;
    web = await next(query);
  }
  // Google News matches loosely ("portable cots" for a software release), so its headlines only
  // follow the web results, which already hold recent pages.
  if (!news.length) return web;
  const seen = new Set(web.map((r) => r.url));
  return [...web, ...news.filter((r) => !seen.has(r.url))];
}
