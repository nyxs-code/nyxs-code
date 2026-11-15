import { BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "../toolNames";

export function getWebFetchDescription(): string {
  return `Fetches the content of a URL and returns it as readable text (HTML converted to plain text) for you to analyze.

Usage:
- Takes a fully-formed URL and a prompt describing what to extract or look for.
- HTTP URLs are automatically upgraded to HTTPS.
- The page's HTML is downloaded and converted to text (scripts/styles stripped).
- Long pages are read by a helper model that returns only what your prompt asks for, so make the prompt specific (e.g. "the install command and the minimum Node version"). Fetch again with another prompt if you need other details.
- A YouTube video URL (watch, youtu.be, shorts) returns its title, channel, description and the transcript of what is said, with [m:ss] times you can cite. Ask in the prompt for what you need from the video.
- This tool is read-only and does not modify any files.
- If you need up-to-date results across many pages, use ${WEB_SEARCH_TOOL_NAME} first to find URLs, then ${"WebFetch"} the relevant ones.
- For GitHub URLs, prefer the \`gh\` CLI via ${BASH_TOOL_NAME} (gh pr view, gh issue view, gh api) instead of fetching the HTML.`;
}
