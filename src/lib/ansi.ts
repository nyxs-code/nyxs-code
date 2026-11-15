// CSI sequences (colors, cursor moves), OSC sequences (titles, hyperlinks) and the remaining
// two-byte escapes. Dev servers like Vite color their output even when it isn't a terminal.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Removes terminal escape codes so command output reads as plain text outside a terminal. */
export function stripAnsi(text: string): string {
  return text.includes("\x1b") || text.includes("\x9b") ? text.replace(ANSI_RE, "") : text;
}

/** Standard 8 terminal colors, by SGR offset (30-37 / 90-97). Gray stands in for black and
 *  white, which would vanish on one of the two themes. */
export type AnsiColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "gray";
const SGR_COLORS: (AnsiColor | undefined)[] = [undefined, "red", "green", "yellow", "blue", "magenta", "cyan", "gray"];

export interface AnsiRun {
  text: string;
  color?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
}

/** Splits terminal output into styled runs: foreground colors, bold and dim are kept, every
 *  other escape is dropped. Lines redrawn with a bare `\r` (progress bars) keep only their last
 *  version, as a terminal would show them. */
export function ansiRuns(raw: string): AnsiRun[] {
  const text = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
  const runs: AnsiRun[] = [];
  let style: Omit<AnsiRun, "text"> = {};
  let last = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    const prev = runs[runs.length - 1];
    // An escape that changed nothing visible (a cursor move, a repeated color) shouldn't split the text.
    if (prev && prev.color === style.color && !prev.bold === !style.bold && !prev.dim === !style.dim) prev.text += chunk;
    else runs.push({ text: chunk, ...style });
  };
  for (const m of text.matchAll(ANSI_RE)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    // eslint-disable-next-line no-control-regex
    const sgr = /^(?:\x1b\[|\x9b)([\d;]*)m$/.exec(m[0]);
    if (!sgr) continue;
    const codes = sgr[1] ? sgr[1].split(";").map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style = { ...style, bold: true };
      else if (c === 2) style = { ...style, dim: true };
      else if (c === 22) style = { ...style, bold: undefined, dim: undefined };
      else if (c === 39) style = { ...style, color: undefined };
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) style = { ...style, color: SGR_COLORS[c % 10] ?? "gray" };
      // 256-color and truecolor carry their own arguments; skip them rather than read them as codes.
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : 4;
    }
  }
  push(text.slice(last));
  return runs;
}
