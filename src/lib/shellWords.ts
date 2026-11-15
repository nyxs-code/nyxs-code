/** Reading shell command lines the agent ran: their segments and the folder each one runs in.
 *  Shared by prArchive (`gh pr create`) and prDetect (`git push`). */

/** Splits a command line into words per shell segment, keeping quoted text as one word. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  let word: string | null = null;
  const push = () => {
    if (word !== null) segments[segments.length - 1].push(word);
    word = null;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      const end = close < 0 ? command.length : close;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (/\s/.test(ch) && ch !== "\n") push();
    else if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
      push();
      if (segments[segments.length - 1].length) segments.push([]);
    } else word = (word ?? "") + ch;
  }
  push();
  return segments.filter((s) => s.length);
}

/** `p` resolved against `base`, unless it is absolute already. */
export const resolvePath = (base: string, p: string): string =>
  /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p) ? p : `${base.replace(/[\\/]+$/, "")}/${p}`;

/** The folder a segment changes to (`cd x`, cmd's `cd /d x`, `Set-Location -Path x`, `pushd x`),
 *  or null when it isn't one. */
export function cdTarget(words: string[]): string | null {
  if (words[0] !== "cd" && words[0] !== "Set-Location" && words[0] !== "pushd") return null;
  // cmd's `cd /d D:\x` and PowerShell's `-Path` come before the folder.
  return words.slice(1).find((w) => !/^(?:\/d|-Path|-LiteralPath)$/i.test(w)) ?? null;
}
