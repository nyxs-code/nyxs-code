export const DEFER_THRESHOLD = 8;

export interface DeferredToolInfo {
  name: string;
  summary: string;
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
}

export function rankDeferredTools(catalog: DeferredToolInfo[], query: string, max: number): DeferredToolInfo[] {
  const q = (query ?? "").trim();
  if (!q) return [];

  if (/^select:/i.test(q)) {
    const want = new Set(
      q.slice(q.indexOf(":") + 1).split(",").map((s) => s.trim()).filter(Boolean),
    );
    return catalog.filter((c) => want.has(c.name)).slice(0, max);
  }

  const qt = tokenize(q);
  if (!qt.length) return [];
  const scored = catalog
    .map((c) => {
      const lname = c.name.toLowerCase();
      const hay = new Set(tokenize(`${c.name} ${c.summary}`));
      let s = 0;
      for (const t of qt) {
        if (hay.has(t)) s += 2;
        if (lname.includes(t)) s += 3;
      }
      return { c, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.name.length - b.c.name.length);
  return scored.slice(0, max).map((x) => x.c);
}

export function getToolSearchDescription(catalog: DeferredToolInfo[]): string {
  const list = catalog.map((c) => `- ${c.name}${c.summary ? `: ${c.summary}` : ""}`).join("\n");
  return (
    `Search and ACTIVATE deferred tools on demand. To save context, the ${catalog.length} tools ` +
    `below (less common built-in tools and MCP tools) are listed by name only — their input schemas ` +
    `are NOT loaded up front, so calling one before activating it fails. Call ToolSearch with ` +
    `keywords for what you need (or "select:Name1,Name2" for exact names); the matching tools stay ` +
    `callable for the rest of the conversation.\n\n` +
    `Deferred tools:\n${list}`
  );
}
