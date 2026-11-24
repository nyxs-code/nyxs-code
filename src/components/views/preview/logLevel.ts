/** A line that reads as an error or a warning gets its color in the dev server logs, as in
 *  Claude Code Desktop. */
export function lineLevel(line: string): "error" | "warn" | null {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (/\b(error|failed|exception|fatal)\b|ERR!|✘/i.test(plain)) return "error";
  if (/\b(warn|warning|deprecated)\b|⚠/i.test(plain)) return "warn";
  return null;
}
