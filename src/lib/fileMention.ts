const AT_TOKEN_CHARS = String.raw`[\p{L}\p{N}\p{M}_\-./\\()[\]~:]`;
const HAS_AT_SYMBOL_RE = new RegExp(`(^|\\s)@(${AT_TOKEN_CHARS}*|"[^"]*"?)$`, "u");
const QUOTED_AT_RE = /@"([^"]*)"?$/;

export interface AtToken {
  query: string;
  startPos: number;
  quoted: boolean;
}

export function getAtToken(text: string, cursor: number): AtToken | null {
  const before = text.slice(0, cursor);

  const quoted = QUOTED_AT_RE.exec(before);
  if (quoted && (quoted.index === 0 || /\s/.test(before[quoted.index - 1] ?? ""))) {
    return { query: quoted[1] ?? "", startPos: quoted.index, quoted: true };
  }

  const m = HAS_AT_SYMBOL_RE.exec(before);
  if (!m) return null;
  const startPos = m.index + (m[1]?.length ?? 0);
  return { query: before.slice(startPos + 1), startPos, quoted: false };
}

export function applyAtSuggestion(
  text: string,
  cursor: number,
  token: AtToken,
  filePath: string,
): { value: string; cursor: number } {
  const needsQuotes = /\s/.test(filePath);
  const replacement = (needsQuotes ? `@"${filePath}"` : `@${filePath}`) + " ";
  const value = text.slice(0, token.startPos) + replacement + text.slice(cursor);
  return { value, cursor: token.startPos + replacement.length };
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function scoreFile(path: string, query: string): number | null {
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  const name = basename(p);
  const nameStart = p.length - name.length;

  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] !== q[qi]) continue;
    score += 1;
    if (i === prevMatch + 1) score += 5;
    if (i >= nameStart) score += 3;
    if (i === nameStart || p[i - 1] === "/" || p[i - 1] === "-" || p[i - 1] === "_" || p[i - 1] === ".") {
      score += 4;
    }
    prevMatch = i;
    qi++;
  }
  if (qi < q.length) return null;

  score -= path.length * 0.05;
  if (name.startsWith(q)) score += 10;
  return score;
}

export const MAX_FILE_SUGGESTIONS = 12;

export function rankFiles(files: string[], query: string): string[] {
  if (!query) return files.slice(0, MAX_FILE_SUGGESTIONS);
  const scored: { path: string; score: number }[] = [];
  for (const f of files) {
    const s = scoreFile(f, query);
    if (s !== null) scored.push({ path: f, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_FILE_SUGGESTIONS).map((s) => s.path);
}
