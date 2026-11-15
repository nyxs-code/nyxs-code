import { WEB_FETCH_TOOL_NAME } from "../toolNames";

export function getWebSearchDescription(currentYear: number): string {
  return `Searches the web and returns the top results (title, URL, snippet) so you can find up-to-date information beyond your knowledge cutoff.

- Provides current information for recent events and data newer than your training cutoff.
- Returns results as Markdown links with snippets. Optionally restrict to or exclude specific domains.

CRITICAL — sources:
- After answering the user's question using the results, you MUST include a "Sources:" section at the end listing the relevant URLs as Markdown links: [Title](URL). Never skip it.

Usage notes:
- Prefer English-language queries — they generally return more and higher-quality results; translate the findings back into the user's language when you answer.
- Use the current year in queries when looking for recent information: the current year is ${currentYear}. For "latest React docs", search "React documentation ${currentYear}", NOT a past year.
- To read a specific result in full, follow up with ${WEB_FETCH_TOOL_NAME} on its URL.`;
}
