/** The `<pr-created>URL</pr-created>` tag an agent writes for a PR it opened without
 *  `gh pr create`: what it is told, how it is read from the streamed reply, and how the chat
 *  hides it. No app dependencies, so the message renderer can use it. */

/** Tells the agent to name a PR it opened without `gh pr create`, which Nyxs can't see. Shared by
 *  the built-in models' system prompt and the CLI agents' appended instructions. */
export const PR_CREATED_PROMPT = `When you open a pull request by any means other than \`gh pr create\` (the GitHub API, \`gh api\`, \`curl\`, an MCP tool, the web), write its URL once in your reply as <pr-created>https://github.com/owner/repo/pull/123</pr-created> so Nyxs links the PR to this session. The tag is hidden from the user, so also mention the PR in your own words. Don't use it for a PR you didn't open.`;

const TAG_OPEN = "<pr-created>";
const DECLARED_RE = /<pr-created>\s*([\s\S]*?)\s*<\/pr-created>/gi;

/** The URLs the text declares with `<pr-created>`, first seen first. */
export function declaredPrUrls(text: string): string[] {
  return [...new Set([...text.matchAll(DECLARED_RE)].map((m) => m[1].trim()).filter(Boolean))];
}

/** The text without its `<pr-created>` tags, including one still being streamed (opened and not
 *  closed yet, or only part of the opening tag at the very end). */
export function stripPrCreatedTags(text: string): string {
  if (!text.includes("<")) return text;
  let out = text.replace(DECLARED_RE, "").replace(/<pr-created>[\s\S]*$/i, "");
  const lt = out.lastIndexOf("<");
  if (lt >= 0 && out.length - lt >= 2 && TAG_OPEN.startsWith(out.slice(lt).toLowerCase())) out = out.slice(0, lt);
  return out;
}

/** Reads streamed reply text and calls `found` once for each URL declared in a closed tag. Keeps
 *  only the tail that may hold a tag still being written. */
export function createDeclaredPrScanner(found: (url: string) => void): (delta: string) => void {
  let buf = "";
  const seen = new Set<string>();
  return (delta) => {
    buf += delta;
    let end = 0;
    for (const m of buf.matchAll(DECLARED_RE)) {
      const url = m[1].trim();
      if (url && !seen.has(url)) {
        seen.add(url);
        found(url);
      }
      end = (m.index ?? 0) + m[0].length;
    }
    buf = buf.slice(end);
    const open = buf.toLowerCase().indexOf(TAG_OPEN);
    buf = open >= 0 ? buf.slice(open) : buf.slice(-TAG_OPEN.length);
    // An opened tag that never closes isn't a declaration.
    if (buf.length > 4096) buf = "";
  };
}
