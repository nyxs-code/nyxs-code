/** The search engines the built-in browser's address bar can send a search to. */
export type SearchEngineId = "google" | "duckduckgo" | "bing" | "brave" | "custom";

/** `suggest` is the engine's OpenSearch suggestions endpoint, which answers `[query, [words…]]`
 *  as browsers' address bars use it. */
export const SEARCH_ENGINES: { id: Exclude<SearchEngineId, "custom">; name: string; url: string; suggest: string }[] = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q=%s", suggest: "https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=%s" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s", suggest: "https://duckduckgo.com/ac/?type=list&q=%s" },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=%s", suggest: "https://api.bing.com/osjson.aspx?query=%s" },
  { id: "brave", name: "Brave Search", url: "https://search.brave.com/search?q=%s", suggest: "https://search.brave.com/api/suggest?q=%s" },
];

export const DEFAULT_SEARCH_ENGINE: SearchEngineId = "google";

/** A custom search address works when it is a web address with `%s` where the words go. */
export function isValidSearchTemplate(template: string): boolean {
  const t = template.trim();
  if (!t.includes("%s") || !/^https?:\/\//i.test(t)) return false;
  try {
    new URL(t.replace(/%s/g, "q"));
    return true;
  } catch {
    return false;
  }
}

export interface SearchChoice {
  engine?: string;
  customUrl?: string;
  customSuggestUrl?: string;
}

/** The engine in use: an unknown id, or a custom one without a valid address, is Google. */
function resolve({ engine, customUrl }: SearchChoice): { name: string; url: string } {
  if (engine === "custom" && customUrl && isValidSearchTemplate(customUrl)) {
    const t = customUrl.trim();
    return { name: new URL(t.replace(/%s/g, "q")).hostname.replace(/^www\./, ""), url: t };
  }
  const known = SEARCH_ENGINES.find((e) => e.id === engine) ?? SEARCH_ENGINES[0];
  return { name: known.name, url: known.url };
}

/** The address that searches `query` with the chosen engine. */
export function searchUrl(query: string, choice: SearchChoice = {}): string {
  return resolve(choice).url.replace(/%s/g, encodeURIComponent(query.trim()));
}

/** The engine's name, for "Search … for …". */
export function searchEngineName(choice: SearchChoice = {}): string {
  return resolve(choice).name;
}

/** Where to ask the chosen engine what people search that starts with `query`. A custom engine
 *  asks its own suggestions address when it has a valid one, and otherwise nothing: the words
 *  typed aren't sent to another engine behind the user's back. */
export function suggestionsUrl(query: string, choice: SearchChoice = {}): string | undefined {
  const q = encodeURIComponent(query.trim());
  if (choice.engine === "custom") {
    const t = choice.customSuggestUrl?.trim();
    return t && isValidSearchTemplate(t) ? t.replace(/%s/g, q) : undefined;
  }
  const known = SEARCH_ENGINES.find((e) => e.id === choice.engine) ?? SEARCH_ENGINES[0];
  return known.suggest.replace(/%s/g, q);
}

/** The words in an OpenSearch suggestions answer (`[query, [words…], …]`); empty when it isn't one. */
export function parseSuggestions(body: unknown): string[] {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return [];
  return body[1].filter((s): s is string => typeof s === "string" && s.trim() !== "");
}
