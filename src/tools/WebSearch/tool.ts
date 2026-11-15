import { tool } from "ai";
import { z } from "zod";
import { hostOf } from "@/lib/toolDetail";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";
import { getWebSearchDescription } from "@/tools/WebSearch/prompt";
import { truncateForTool } from "@/tools/limits";
import * as Names from "@/tools/toolNames";
import { addressInQuery, formatPageMeta, lookUpPage, searchTheWeb, type SearchResult } from "@/tools/web";

/** Drops the site's name that titles often end with ("… - YouTube"), which only adds noise.
 *  Empty when the title is only the site's name (a YouTube id that isn't a video). */
export function searchableTitle(title: string, address: string): string {
  const site = hostOf(address).replace(/^www\./, "").split(".")[0];
  const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (!site) return title;
  if (bare(title) === site) return "";
  const m = /^(.+?)\s+[-|–·]\s+([^-|–·]+)$/.exec(title);
  return m && bare(m[2]) === site ? m[1].trim() : title;
}

export function createWebSearchTool(ctx: Pick<ToolContext, "gate">) {
  return tool({
    description: getWebSearchDescription(new Date().getFullYear()),
    inputSchema: z.object({
      query: z.string().describe("The search query."),
      allowed_domains: z.array(z.string()).optional().describe("Only include results from these domains."),
      blocked_domains: z.array(z.string()).optional().describe("Exclude results from these domains."),
    }),
    execute: async ({ query, allowed_domains, blocked_domains }, { abortSignal }) => {
      try {
        // A bare address finds nothing useful, so search for what that page is about instead.
        // Reading it is a fetch, so it asks like WebFetch does.
        let intro = "";
        let searchFor = query;
        const found = addressInQuery(query);
        if (found) {
          const denied = await checkGate(ctx.gate, "WebFetch", { url: found.url });
          // A redirect from there into this computer or the local network asks as WebFetch does.
          const page = denied ? null : await lookUpPage(found.url, abortSignal, async (next) => !(await checkGate(ctx.gate, "WebFetch", { url: next })));
          const title = page ? searchableTitle(page.title, found.url) : "";
          if (title) {
            searchFor = title;
            intro = `The query points to ${found.url}. What that page says about itself:\n${formatPageMeta(page!)}\n\n`;
          } else if (!found.guessed) {
            return `WebSearch: "${query}" holds a web address, and search engines don't find pages by address. Use ${Names.WEB_FETCH_TOOL_NAME} on ${found.url}, or search for its topic in words.`;
          }
        }
        let results: SearchResult[] = await searchTheWeb(searchFor);
        const allow = (allowed_domains ?? []).map((d) => d.toLowerCase());
        const block = (blocked_domains ?? []).map((d) => d.toLowerCase());
        if (allow.length) results = results.filter((r) => allow.some((d) => hostOf(r.url).includes(d)));
        if (block.length) results = results.filter((r) => !block.some((d) => hostOf(r.url).includes(d)));
        results = results.slice(0, 10);
        if (!results.length) {
          if (intro) return truncateForTool(Names.WEB_SEARCH_TOOL_NAME, `${intro}No search results for "${searchFor}".`);
          return `WebSearch: no results for "${query}" (the search engines may be rate-limiting; try a shorter query, or if you know a relevant URL, use WebFetch instead).`;
        }
        const formatted = results
          .map((r, i) => `${i + 1}. [${r.title}](${r.url})${r.snippet ? `\n   ${r.snippet}` : ""}`)
          .join("\n\n");
        return truncateForTool(Names.WEB_SEARCH_TOOL_NAME, `${intro}Search results for "${searchFor}":\n\n${formatted}`);
      } catch (e) {
        return `WebSearch failed for "${query}": ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}
