import { useMemo, useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { openChatLink } from "@/lib/openExternal";
import { tokenize, langFromPath } from "@/lib/highlight";
import { useTranslations } from "@/lib/i18n";
import { parseAlign } from "@/lib/markdownTable";
import { MarkdownTable } from "./MarkdownTable";
import { InlineCode } from "./FilePathCode";
import { currentWorkspace, openPathRef, parsePathRef, pathKind } from "@/lib/filePaths";

export function Highlighted({ code, lang }: { code: string; lang: string }) {
  const tokens = useMemo(() => tokenize(code, lang), [code, lang]);
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} className={t.cls}>
          {t.text}
        </span>
      ))}
    </>
  );
}

// The last one is a bare http(s) URL, without the punctuation that usually follows a link in
// prose (a final ".", ",", ")"...).
const INLINE =
  /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()[\]`]*[^\s<>()[\]`.,;:!?'"])/g;

const LINK_CLS = "text-[color:var(--link)] hover:underline underline-offset-2 cursor-pointer";

/** A link in a message: a web address opens like the chat's other links; a path in the project
 *  (`[App.tsx](src/App.tsx)`) opens the file, as clickable inline paths do. */
function openLink(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    openChatLink(url);
    return;
  }
  let target = url;
  try {
    target = decodeURIComponent(url);
  } catch {
    // Not percent-encoded as expected: use it as written.
  }
  const ref = parsePathRef(target.replace(/^file:\/\/\/?/i, "").replace(/#L(\d+).*$/, ":$1"), currentWorkspace());
  if (!ref) return;
  void pathKind(ref.abs).then((kind) => {
    if (kind !== "none") openPathRef(ref, kind);
  });
}

const WORD_CHAR = /[A-Za-z0-9_]/;

/** Text the model is writing, one span per word, so each new word comes in blurred and clears
 *  (`.stream-word`). Keys go by position: a word already on screen keeps its span and doesn't
 *  animate again when more text arrives. */
function streamWords(text: string, keyPrefix: string): ReactNode[] {
  return (text.match(/\S+\s*|\s+/g) ?? []).map((w, i) => (
    <span key={`${keyPrefix}-${i}`} className="stream-word">{w}</span>
  ));
}

function renderInline(text: string, keyPrefix: string, streaming = false): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  let t = 0;
  const pushText = (s: string) => {
    if (streaming) nodes.push(...streamWords(s, `${keyPrefix}-t${t++}`));
    else nodes.push(s);
  };
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) pushText(text.slice(last, m.index));
    const key = `${keyPrefix}-${k++}`;
    if (m[1] !== undefined) {
      const end = INLINE.lastIndex;
      nodes.push(<strong key={key} className="font-semibold text-text-100">{renderInline(m[1], key, streaming)}</strong>);
      INLINE.lastIndex = end;
    } else if (m[2] !== undefined) {
      nodes.push(<InlineCode key={key} text={m[2]} />);
    } else if (m[4] !== undefined && (WORD_CHAR.test(text[m.index - 1] ?? "") || WORD_CHAR.test(text[INLINE.lastIndex] ?? ""))) {
      pushText(m[0]);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      // The match ends here; reading what's inside runs the same regex again.
      const end = INLINE.lastIndex;
      nodes.push(<em key={key}>{renderInline((m[3] ?? m[4])!, key, streaming)}</em>);
      INLINE.lastIndex = end;
    } else if (m[5] !== undefined || m[7] !== undefined) {
      const url = m[6] ?? m[7]!;
      nodes.push(
        <a
          key={key}
          href={url}
          onClick={(e) => { e.preventDefault(); openLink(url); }}
          rel="noreferrer"
          className={LINK_CLS}
        >
          {m[5] ?? url}
        </a>,
      );
    }
    last = INLINE.lastIndex;
  }
  if (last < text.length) pushText(text.slice(last));
  return nodes;
}

const isBullet = (l: string) => /^\s*[-*]\s+/.test(l);
const isNumbered = (l: string) => /^\s*\d+\.\s+/.test(l);
const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
const isQuote = (l: string) => /^\s*>/.test(l);
const isContinuation = (l: string) => /^(?: {2,}|\t)\S/.test(l) && !isBullet(l) && !isNumbered(l);
const listDepth = (l: string) => Math.min(4, Math.floor((/^\s*/.exec(l)?.[0].replace(/\t/g, "  ").length ?? 0) / 2));
const HEADING_TAGS = ["h2", "h2", "h3", "h4", "h5", "h6"] as const;
const isTableRow = (l: string) => l.includes("|");
const isTableSep = (l: string) => {
  const t = l.trim();
  return t.includes("|") && t.includes("-") && /^[\s|:-]+$/.test(t);
};
function parseRow(line: string): string[] {
  const cells = line.trim().split("|");
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** `streaming`: the model is still writing this text, so its new words animate in. */
export function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const parsed = useMemo(() => buildBlocks(text, streaming), [text, streaming]);
  return <>{parsed}</>;
}

/** With `streaming`, only the last block is split into word spans: new words only land there,
 *  and the blocks above stay plain text however long the reply gets. */
function buildBlocks(text: string, streaming = false): ReactNode[] {
  const lines = text.replace(/^\n+|\n+$/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  // Asked once a block has taken its lines: it is the last one if none are left.
  const live = () => streaming && i >= lines.length;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = parseRow(line);
      const align = parseAlign(parseRow(lines[i + 1]));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push(<MarkdownTable key={key} id={key} header={header} rows={rows} align={align} inline={renderInline} />);
      key++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const size = level <= 1 ? "text-lg" : level === 2 ? "text-base" : "text-[15px]";
      const Heading = HEADING_TAGS[level - 1];
      i++;
      blocks.push(
        <Heading key={key} className={cn("font-semibold text-text-100 mt-3 mb-1", size)}>
          {renderInline(h[2], `h${key}`, live())}
        </Heading>,
      );
      key++;
      continue;
    }

    if (isQuote(line)) {
      const quoted: string[] = [];
      while (i < lines.length && isQuote(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key} className="my-2.5 border-l-2 border-bg-300 pl-3 text-text-300">
          {buildBlocks(quoted.join("\n"), live())}
        </blockquote>,
      );
      key++;
      continue;
    }

    if (isBullet(line)) {
      const items: Array<{ text: string; depth: number }> = [];
      while (i < lines.length && isBullet(lines[i])) {
        items.push({ text: lines[i].replace(/^\s*[-*]\s+/, ""), depth: listDepth(lines[i]) });
        i++;
      }
      const writing = live();
      blocks.push(
        <ul key={key} className="list-disc pl-5 my-1.5 space-y-1">
          {items.map((it, j) => (
            <li key={j} className="text-[15px] leading-[1.7]" style={it.depth ? { marginLeft: it.depth * 18 } : undefined}>
              {renderInline(it.text, `ul${key}-${j}`, writing)}
            </li>
          ))}
        </ul>,
      );
      key++;
      continue;
    }

    if (isNumbered(line)) {
      // The list goes on from its own number: after a blank line, a code block or a paragraph,
      // "3." is item 3, not a new 1.
      const start = Number(/^\s*(\d+)\./.exec(line)![1]);
      const items: string[] = [];
      while (i < lines.length && isNumbered(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
        // An indented line under an item is more of that item, not a paragraph after the list.
        while (i < lines.length && isContinuation(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i++;
        }
      }
      const writing = live();
      blocks.push(
        <ol key={key} start={start !== 1 ? start : undefined} className="list-decimal pl-5 my-1.5 space-y-1">
          {items.map((it, j) => (
            <li key={j} className="text-[15px] leading-[1.7]">{renderInline(it, `ol${key}-${j}`, writing)}</li>
          ))}
        </ol>,
      );
      key++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isHeading(lines[i]) &&
      !isQuote(lines[i]) &&
      !isBullet(lines[i]) &&
      !isNumbered(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key} className="whitespace-pre-wrap break-words text-[15px] leading-[1.75] my-2.5">
        {renderInline(para.join("\n"), `p${key}`, live())}
      </p>,
    );
    key++;
  }

  return blocks;
}

const CODE_LANGS = new Set([
  "html", "htm", "xml", "svg", "js", "jsx", "mjs", "cjs", "ts", "tsx", "javascript", "typescript",
  "json", "jsonc", "css", "scss", "sass", "less", "python", "py", "bash", "sh", "shell", "zsh",
  "sql", "rust", "rs", "go", "golang", "java", "c", "h", "cpp", "cc", "cxx", "hpp", "csharp", "cs",
  "php", "ruby", "rb", "swift", "kotlin", "kt", "toml", "ini", "yaml", "yml", "dockerfile", "makefile",
  "diff", "patch", "graphql", "proto", "vue", "astro", "lua", "perl", "dart", "scala", "elixir", "haskell",
]);

// Drafts meant to be copied (an email, a message): read as normal text, not as code.
const PROSE_LANGS = new Set(["text", "txt", "plain", "plaintext", "email", "mail", "message"]);

function looksLikeMarkdown(s: string): boolean {
  let signals = 0;
  if (/^#{1,6}\s+\S/m.test(s)) signals++;
  if (/\*\*[^*\n]+\*\*/.test(s)) signals++;
  if (/^\s*[-*]\s+\S/m.test(s)) signals++;
  if (/^\s*\d+\.\s+\S/m.test(s)) signals++;
  if (/\[[^\]]+\]\([^)\s]+\)/.test(s)) signals++;
  return signals >= 2;
}

export function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const tx = useTranslations().messageExtra;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const lc = lang.toLowerCase();

  const asMarkdown = lc === "markdown" || lc === "md" || (!CODE_LANGS.has(lc) && looksLikeMarkdown(content));
  const asProse = !asMarkdown && PROSE_LANGS.has(lc);
  // Unboxed, like Claude Code: the block is only as wide as its longest line, so the copy icon
  // sits right after the content; long lines wrap instead of scrolling, as the edit diffs do.
  return (
    <div className="relative my-4 w-fit max-w-full pl-4 pr-10">
      <button
        onClick={copy}
        aria-label={copied ? tx.copied : tx.copy}
        data-tooltip={copied ? tx.copied : tx.copy}
        className="absolute top-0 right-1 p-1 rounded-md text-text-400 hover:text-text-100 hover:bg-bg-200 transition-colors"
      >
        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      </button>
      {asMarkdown ? (
        <MarkdownText text={content} />
      ) : asProse ? (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[15px] leading-[1.75] text-text-100">{content}</p>
      ) : (
        <pre className="text-[13px] leading-relaxed">
          <code className="font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
            <Highlighted code={content} lang={langFromPath(lang)} />
          </code>
        </pre>
      )}
    </div>
  );
}
