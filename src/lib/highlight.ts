export interface Token {
  text: string;
  cls: string;
}

const C = {
  comment: "text-[color:var(--code-comment)]",
  string: "text-[color:var(--code-string)]",
  keyword: "text-[color:var(--code-keyword)]",
  tag: "text-[color:var(--code-tag)]",
  attr: "text-[color:var(--code-attr)]",
  number: "text-[color:var(--code-number)]",
  func: "text-[color:var(--code-func)]",
  plain: "text-[color:var(--code-plain)]",
} as const;

export function langFromPath(path: string): string {
  const ext = path.split(/[.\\/]/).pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "mts", "cts", "typescript"].includes(ext)) return "ts";
  if (["js", "jsx", "mjs", "cjs", "javascript"].includes(ext)) return "js";
  if (["css", "scss", "less"].includes(ext)) return "css";
  if (["html", "htm", "xml", "svg", "vue"].includes(ext)) return "html";
  if (["json", "jsonc"].includes(ext)) return "json";
  if (["sh", "bash", "zsh", "shell"].includes(ext)) return "sh";
  if (["py", "python"].includes(ext)) return "py";
  return ext || "text";
}

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch",
  "case", "break", "continue", "new", "class", "extends", "super", "this", "import", "export",
  "from", "default", "async", "await", "yield", "try", "catch", "finally", "throw", "typeof",
  "instanceof", "in", "of", "void", "delete", "null", "true", "false", "undefined", "NaN",
  "interface", "type", "enum", "implements", "public", "private", "protected", "readonly",
  "static", "as", "namespace", "declare", "abstract", "satisfies", "keyof", "infer",
  "def", "elif", "lambda", "None", "True", "False", "and", "or", "not", "pass", "with", "global",
]);

const HASH_COMMENT_LANGS = new Set(["sh", "py", "yaml", "yml", "toml", "ruby", "rb"]);

const RE_HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/y;
const RE_BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/y;
const RE_LINE_COMMENT = /\/\/[^\n]*/y;
const RE_HASH_COMMENT = /#[^\n]*/y;
const RE_STRING = /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?/y;
const RE_HEX = /#[0-9a-fA-F]{3,8}\b/y;
const RE_NUMBER = /\b\d[\d._]*(?:[eE][+-]?\d+)?(?:px|em|rem|%|vh|vw|s|ms|fr|deg)?\b|0x[0-9a-fA-F]+/y;
const RE_TAG = /<[!/]?[a-zA-Z][\w-]*/y;
const RE_IDENT = /[A-Za-z_$][\w$-]*/y;
const RE_PUNCT = /[{}()[\];:,.<>=+\-*/%&|!?@~^]+/y;
const RE_WS = /\s+/y;

/** Shell colors for the runnable command blocks. They sit on the app's own surface, not on the
 *  code theme's background, so they follow the app theme instead of the code palette (a dark code
 *  theme's pale "plain" turned the whole command gray there). */
const SH = {
  command: "text-violet-600 dark:text-violet-400",
  arg: "text-blue-900 dark:text-blue-200",
  flag: "text-cyan-700 dark:text-cyan-400",
  string: "text-emerald-700 dark:text-emerald-400",
  variable: "text-amber-700 dark:text-amber-400",
  comment: "text-text-400",
  op: "text-text-300",
} as const;

const SH_OPERATOR = /\d?>>?(?:&\d)?|&&|\|\||[|;<&]/y;
const SH_STARTS_COMMAND = new Set(["|", "||", "&&", ";", "&"]);
const SH_VARIABLE = /\$(?:\{[^}\n]*\}?|env:\w+|\w+|\()/y;
const SH_WORD = /[^\s'"|;&<>()$]+/y;

/** Shell command line(s): the program in each command (after `|`, `&&`, `;`…) stands out from
 *  its arguments, like a terminal's syntax highlighting. Works for bash and PowerShell alike. */
export function tokenizeShell(code: string): Token[] {
  const out: Token[] = [];
  const push = (text: string, cls: string) => {
    if (text) out.push({ text, cls });
  };
  const at = (re: RegExp, i: number) => {
    re.lastIndex = i;
    return re.exec(code)?.[0] ?? null;
  };
  let expectCommand = true;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    let m: string | null;
    if (ch === "\n") {
      push(ch, "");
      expectCommand = true;
      i++;
      continue;
    }
    if ((m = at(RE_WS, i))) {
      // Whitespace can span lines; keep the newline handling above in charge of those.
      const nl = m.indexOf("\n");
      const ws = nl < 0 ? m : m.slice(0, nl);
      if (ws) { push(ws, ""); i += ws.length; continue; }
    }
    if (ch === "#" && (i === 0 || /\s/.test(code[i - 1]))) {
      m = at(RE_HASH_COMMENT, i)!;
      push(m, SH.comment);
      i += m.length;
      continue;
    }
    // A pasted prompt ("$ npm test") is not part of the command.
    if (expectCommand && ch === "$" && code[i + 1] === " " && (i === 0 || code[i - 1] === "\n")) {
      push("$", SH.comment);
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      m = at(RE_STRING, i)!;
      push(m, SH.string);
      i += m.length;
      expectCommand = false;
      continue;
    }
    if (ch === "$" && (m = at(SH_VARIABLE, i))) {
      push(m, SH.variable);
      i += m.length;
      // `$(` opens a subcommand; any other variable in command position is an assignment.
      expectCommand = m === "$(";
      continue;
    }
    if ((m = at(SH_OPERATOR, i)) && !(ch >= "0" && ch <= "9" && m.length === 1)) {
      push(m, SH.op);
      i += m.length;
      if (SH_STARTS_COMMAND.has(m)) expectCommand = true;
      continue;
    }
    if (ch === "(" || ch === ")") {
      push(ch, SH.op);
      i++;
      if (ch === "(") expectCommand = true;
      continue;
    }
    if ((m = at(SH_WORD, i))) {
      let cls: string = SH.arg;
      if (expectCommand && /^\w+=/.test(m)) cls = SH.variable;
      else if (expectCommand) {
        cls = SH.command;
        expectCommand = false;
      } else if (m.startsWith("-")) cls = SH.flag;
      push(m, cls);
      i += m.length;
      continue;
    }
    push(ch, SH.arg);
    i++;
  }
  return out;
}

export function tokenize(code: string, lang: string): Token[] {
  const out: Token[] = [];
  if (code.length > 40_000) return [{ text: code, cls: C.plain }];

  const push = (text: string, cls: string) => {
    if (text) out.push({ text, cls });
  };
  const tryRe = (re: RegExp, i: number): string | null => {
    re.lastIndex = i;
    const m = re.exec(code);
    return m ? m[0] : null;
  };

  const hashComment = HASH_COMMENT_LANGS.has(lang);
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    let m: string | null;

    if (ch === "<" && (m = tryRe(RE_HTML_COMMENT, i))) { push(m, C.comment); i += m.length; continue; }
    if (ch === "/" && (m = tryRe(RE_BLOCK_COMMENT, i))) { push(m, C.comment); i += m.length; continue; }
    if (ch === "/" && (m = tryRe(RE_LINE_COMMENT, i))) { push(m, C.comment); i += m.length; continue; }
    if (ch === "#" && hashComment && (m = tryRe(RE_HASH_COMMENT, i))) { push(m, C.comment); i += m.length; continue; }
    if (ch === "#" && !hashComment && (m = tryRe(RE_HEX, i))) { push(m, C.number); i += m.length; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      if ((m = tryRe(RE_STRING, i))) { push(m, C.string); i += m.length; continue; }
    }
    if (ch === "<" && (m = tryRe(RE_TAG, i))) {
      const lead = /^<[!/]?/.exec(m)![0];
      push(lead, C.plain);
      push(m.slice(lead.length), C.tag);
      i += m.length;
      continue;
    }
    if (ch >= "0" && ch <= "9" && (m = tryRe(RE_NUMBER, i))) { push(m, C.number); i += m.length; continue; }
    if ((m = tryRe(RE_IDENT, i))) {
      const after = code.slice(i + m.length);
      let cls: string = C.plain;
      if (KEYWORDS.has(m)) cls = C.keyword;
      else if (/^\s*=(?!=)/.test(after)) cls = C.attr;
      else if (lang === "css" && /^\s*:/.test(after)) cls = C.attr;
      else if (/^\s*\(/.test(after)) cls = C.func;
      push(m, cls);
      i += m.length;
      continue;
    }
    if ((m = tryRe(RE_WS, i))) { push(m, C.plain); i += m.length; continue; }
    if ((m = tryRe(RE_PUNCT, i))) { push(m, C.plain); i += m.length; continue; }
    push(ch, C.plain);
    i += 1;
  }
  return out;
}
