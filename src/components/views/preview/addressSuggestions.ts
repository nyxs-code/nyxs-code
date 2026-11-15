import { classifyAddress } from "./addressInput";

/** One row of the address bar's list: `value` is what opens when it's picked. */
export interface AddressSuggestion {
  /** `address`: go to what was typed; `search`: search what was typed; `suggestion`: a search
   *  the engine suggested. */
  kind: "address" | "search" | "suggestion";
  value: string;
  /** What the row shows: the address or the words. */
  label: string;
  /** The engine's name, on the row that searches what was typed. */
  detail?: string;
}

const MAX_SUGGESTIONS = 7;

/** An address as it is shown: no scheme, no `www.`, no trailing slash. */
export function displayAddress(url: string): string {
  return url.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

/** Whether the typed text may be sent to the search engine for suggestions. A path or an
 *  address on this machine or its network never leaves it. */
export function wantsWebSuggestions(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  const target = classifyAddress(q);
  if (target.kind === "path") return false;
  if (target.kind === "search") return true;
  try {
    const host = new URL(target.url).hostname.toLowerCase();
    return !/^(localhost|.*\.localhost|.*\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[.*\])$/.test(host);
  } catch {
    return false;
  }
}

/** The address bar's rows for `query`, as a browser's: first what was typed (go there, or
 *  search it), then what the search engine suggests. Nothing comes from this machine's history
 *  or the project; a file still opens when its name is typed whole and Enter pressed. */
export function buildAddressSuggestions(query: string, web: readonly string[], engineName: string): AddressSuggestion[] {
  const q = query.trim();
  if (!q) return [];
  const target = classifyAddress(q);
  const out: AddressSuggestion[] = [
    target.kind === "search"
      ? { kind: "search", value: q, label: q, detail: engineName }
      : { kind: "address", value: q, label: target.kind === "web" ? displayAddress(target.url) : q },
  ];
  const seen = new Set([q.toLowerCase()]);
  for (const s of web) {
    const words = s.trim();
    if (seen.has(words.toLowerCase())) continue;
    seen.add(words.toLowerCase());
    out.push({ kind: "suggestion", value: words, label: words });
    if (out.length > MAX_SUGGESTIONS) break;
  }
  return out;
}
