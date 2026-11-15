import { validateTimeline } from "./timelineSchema";

const MAX_ERRORS = 40;

/** Whether `path` is a Nyxs Video document (`…/videos/<slug>/timeline.json`). */
export function isVideoTimelinePath(path: string): boolean {
  return /(^|[\\/])videos[\\/][^\\/]+[\\/]timeline\.json$/i.test(path);
}

/** A `<diagnostics>` block with the schema errors of a timeline.json the agent just wrote, or
 *  null when it is valid. Same shape as the linters' blocks, so the chat chip shows it too. */
export function timelineDiagnostics(content: string, relPath: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (e) {
    return block(relPath, [`invalid JSON: ${e instanceof Error ? e.message : String(e)}`]);
  }
  const result = validateTimeline(json);
  if (result.ok) return null;
  const shown = result.errors.slice(0, MAX_ERRORS);
  if (result.errors.length > shown.length) shown.push(`… and ${result.errors.length - shown.length} more`);
  return block(relPath, shown);
}

function block(relPath: string, errors: string[]): string {
  return [
    `<diagnostics file="${relPath}" tool="timeline">`,
    "timeline.json doesn't match the Nyxs Video schema (see the `video` skill), so the player and renders can't use it. Fix each error below:",
    "",
    ...errors.map((e) => `error: ${e}`),
    "</diagnostics>",
  ].join("\n");
}
