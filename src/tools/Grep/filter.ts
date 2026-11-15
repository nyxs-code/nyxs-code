/** A Grep result without the lines of files a deny rule hides. Paths come first on each line:
 *  alone (files_with_matches), or as `path:N:text` for a match and `path-N-text` for context.
 *  Both readings of a line are checked, so a name or text that looks like the other can't let
 *  a hidden file through. A count says nothing about any file and is kept. */
export function withoutDeniedFiles(out: string, mode: string | undefined, denied: (abs: string) => boolean): string {
  if (mode === "count" || out === "No matches.") return out;
  // A truncation notice follows the results after a blank line.
  const [body, ...notes] = out.split("\n\n");
  const seen = new Map<string, boolean>();
  const isDenied = (file: string) => {
    let hit = seen.get(file);
    if (hit === undefined) seen.set(file, (hit = denied(file)));
    return hit;
  };
  const filesOf = (line: string): string[] =>
    mode === "content"
      ? [/^(.+?):\d+:/.exec(line)?.[1], /^(.+?)-\d+-/.exec(line)?.[1]].filter((f): f is string => !!f)
      : [line];
  const kept = body.split("\n").filter((line) => line === "--" || !filesOf(line).some(isDenied));
  // A context separator with nothing left on one side of it.
  const lines = kept.filter((l, i) => l !== "--" || (i > 0 && i < kept.length - 1 && kept[i - 1] !== "--"));
  if (!lines.some((l) => l !== "--")) return "No matches.";
  return [lines.join("\n"), ...notes].join("\n\n");
}
