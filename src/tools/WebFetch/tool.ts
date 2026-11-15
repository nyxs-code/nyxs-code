import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { tool } from "ai";
import { z } from "zod";
import { normalizeFetchUrl } from "@/lib/permissions";
import { getWebFetchDescription } from "@/tools/WebFetch/prompt";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";
import { truncateForTool } from "@/tools/limits";
import * as Names from "@/tools/toolNames";
import { WEB_TIMEOUT_MS, WEB_USER_AGENT, formatPageMeta, htmlToText, pageMetadata, withDeadline } from "@/tools/web";
import { fetchYouTubeVideo, formatYouTubeVideo, youTubeVideoId } from "@/tools/youtube";
import { getLanguage } from "@/lib/i18n";

const EXTRACT_OVER_CHARS = 6000;
const EXTRACT_INPUT_CHARS = 120_000;
const EXTRACT_TIMEOUT_MS = 90_000;
const MAX_REDIRECTS = 10;

export function createWebFetchTool(ctx: ToolContext) {
  const { gate, extract } = ctx;
  return tool({
    description: getWebFetchDescription(),
    inputSchema: z.object({
      url: z.string().describe("The URL to fetch (a fully-formed http(s) URL)."),
      prompt: z.string().describe("What information to extract from the page."),
    }),
    execute: async ({ url, prompt }, { abortSignal }) => {
      const denied = await checkGate(gate, "WebFetch", { url });
      if (denied) return denied;
      const target = normalizeFetchUrl(url);
      try {
        const videoId = youTubeVideoId(target);
        const video = videoId ? await withDeadline(() => fetchYouTubeVideo(videoId, captionLanguages(target)), WEB_TIMEOUT_MS, abortSignal) : null;
        if (video) return await answer(target, prompt, formatYouTubeVideo(video), "video", abortSignal);
        const page = await withDeadline(async (signal) => {
          const got = await fetchFollowing(target, signal);
          if ("denied" in got) return got;
          const { res, url: finalUrl } = got;
          return res.ok ? { contentType: res.headers.get("content-type") ?? "", body: await res.text(), finalUrl } : { status: res.status };
        }, WEB_TIMEOUT_MS, abortSignal);
        if ("denied" in page) return page.denied;
        if ("status" in page) return `WebFetch: ${target} returned HTTP ${page.status}.`;
        const { contentType, body, finalUrl } = page;
        const isHtml = /html|xml/i.test(contentType) || /^\s*</.test(body);
        const about = isHtml ? formatPageMeta(pageMetadata(body, finalUrl)) : "";
        const text = isHtml ? [about, htmlToText(body)].filter(Boolean).join("\n\n") : body;
        if (!text.trim()) return `WebFetch: ${target} returned no readable text content.`;
        return await answer(target, prompt, text, "page", abortSignal);
      } catch (e) {
        return `WebFetch failed for ${target}: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  /** Fetches `url` following its redirects one at a time: a hop to another host goes through the
   *  gate like the first address, so a site can't send the fetch to localhost or 169.254.169.254
   *  without the private-network question (the HTTP client would follow it unchecked). */
  async function fetchFollowing(url: string, signal?: AbortSignal): Promise<{ res: Response; url: string } | { denied: string }> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await tauriFetch(current, {
        method: "GET",
        headers: { "User-Agent": WEB_USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*" },
        signal,
        maxRedirections: 0,
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return { res, url: current };
      const next = new URL(location, current).href;
      if (new URL(next).hostname !== new URL(current).hostname) {
        const denied = await checkGate(gate, "WebFetch", { url: next });
        if (denied) return { denied };
      }
      current = next;
    }
    throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
  }

  /** Long content goes to the helper model with the prompt; short content, or when the helper
   *  fails, goes back as it is (truncated to the tool's limit). */
  async function answer(target: string, prompt: string, text: string, what: "page" | "video", abortSignal?: AbortSignal) {
    if (extract && prompt.trim() && text.length > EXTRACT_OVER_CHARS) {
      // A helper model that stalls would hold the turn: past the deadline the page goes back as it is.
      const reply = await withDeadline((signal) => extract(prompt, text.slice(0, EXTRACT_INPUT_CHARS), signal), EXTRACT_TIMEOUT_MS, abortSignal).catch(() => null);
      if (reply?.trim()) {
        return truncateForTool(
          Names.WEB_FETCH_TOOL_NAME,
          `From ${target} — what the ${what} says about "${prompt}" (read by a helper model; fetch again with another prompt for other details):\n\n${reply.trim()}`,
        );
      }
    }
    return truncateForTool(Names.WEB_FETCH_TOOL_NAME, `Content of ${target} (extract: ${prompt}):\n\n${text}`);
  }
}

/** Caption languages to prefer: one the address asks for (`hl=`), then the app's, then the
 *  system's, then English. */
function captionLanguages(target: string): string[] {
  let requested = "";
  try {
    requested = new URL(target).searchParams.get("hl") ?? "";
  } catch {
    // Not a full URL: no language in it.
  }
  const system = typeof navigator !== "undefined" ? navigator.language : "";
  return [requested, getLanguage(), system, "en"].filter(Boolean);
}
