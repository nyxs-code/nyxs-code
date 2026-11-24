import { createContext, useContext } from "react";

/** What a runnable command block in the chat needs from the app: the folder its shell starts in,
 *  and a way to open the Terminal panel when the user wants to see that shell there. */
export interface CommandRunEnv {
  workspace: string | null;
  openView?: (view: string) => void;
  /** The session the transcript belongs to, for what a message does to it (a stopped command's
   *  "Allow in this session"). */
  chatId?: string;
}

export const CommandRunContext = createContext<CommandRunEnv>({ workspace: null });

export const useCommandRunEnv = () => useContext(CommandRunContext);

/** Fence languages that hold a command to run, as opposed to a script or code to read. */
const SHELL_LANGS = new Set(["sh", "bash", "zsh", "shell", "console", "terminal", "powershell", "pwsh", "ps", "ps1", "cmd", "bat"]);

export function isShellLang(lang: string): boolean {
  return SHELL_LANGS.has(lang.trim().toLowerCase());
}

/** One line of a command block. `command` is what Run and Copy use (null for blank and comment
 *  lines, which get no buttons); `text` is the line as shown. */
export interface CommandRow {
  text: string;
  command: string | null;
}

const COMMENT_LINE = /^\s*(#|REM\b|::)/i;
// A line that opens or continues something the next line finishes: run line by line, it breaks.
const CONTINUES = /(\\|`|\^|\||&&|\|\||\{|\(|\bthen|\bdo)\s*$/;
const BLOCK_WORD = /^(?:(?:then|do|done|fi|else|elif|esac|end)\b|[})])/;

/** Drops a `# comment` at the end of the line, as long as the `#` isn't inside quotes or glued
 *  to a word (`a#b`, URLs). */
function stripTrailingComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && i > 0 && /\s/.test(line[i - 1])) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

/** The command itself, without a `$ ` prompt someone pasted along. */
function commandOf(line: string): string {
  return stripTrailingComment(line.trim().replace(/^\$\s+/, ""));
}

/** Splits a block into separate runnable lines when it is a list of independent commands
 *  ("npm run dev # web", "npm test # vitest"). A real script (continuations, heredocs, if/for,
 *  indented bodies) or a single command stays one row with the whole block. */
export function commandRows(content: string): CommandRow[] {
  const text = content.replace(/\n+$/, "");
  const lines = text.split("\n");
  const commands = lines.filter((l) => l.trim() && !COMMENT_LINE.test(l));
  const script =
    commands.length <= 1 ||
    lines.some((l) => /<</.test(l) || CONTINUES.test(stripTrailingComment(l)) || BLOCK_WORD.test(l.trim()) || (/^\s/.test(l) && l.trim()));
  if (script) return [{ text, command: commands.length === 1 ? commandOf(commands[0]) : text }];
  return lines.map((l) => ({ text: l, command: l.trim() && !COMMENT_LINE.test(l) ? commandOf(l) : null }));
}
