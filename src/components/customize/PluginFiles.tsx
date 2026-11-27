import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CodeXml, Eye, Folder, FolderOpen, Loader2 } from "lucide-react";
import { invoke } from "@/lib/ipc";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { langFromPath, tokenize, type Token } from "@/lib/highlight";
import { listPluginFiles } from "@/lib/plugins/pluginDetails";
import { MarkdownText } from "@/components/message/markdown";
import { cn } from "@/lib/utils";

const MAX_LINES = 5000;
/** The files box ends this far above the bottom of the page (the page's own bottom padding). */
export const FILES_BOTTOM_GAP = 16;
const MIN_HEIGHT = 320;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MARKDOWN = /\.(md|markdown)$/i;

interface Node {
  name: string;
  path: string;
  children?: Node[];
}

/** The folders and files as a tree, folders first, each level by name. */
function buildTree(paths: string[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const p of paths) {
    let at = root;
    const parts = p.split("/");
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const last = i === parts.length - 1;
      let next = at.children!.find((c) => c.name === name && !!c.children === !last);
      if (!next) {
        next = last ? { name, path } : { name, path, children: [] };
        at.children!.push(next);
      }
      at = next;
    });
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name));
    for (const n of nodes) if (n.children) sort(n.children);
  };
  sort(root.children!);
  return root.children!;
}

/** The file to show first: the README, else the manifest, else the first file. */
function firstFile(paths: string[]): string | null {
  return (
    paths.find((p) => /^readme(\.md)?$/i.test(p)) ??
    paths.find((p) => /(^|\/)plugin\.json$/.test(p)) ??
    paths[0] ??
    null
  );
}

/** Highlighted tokens cut into lines, so each line gets its number. */
function toLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const tok of tokens) {
    tok.text.split("\n").forEach((piece, i) => {
      if (i > 0) lines.push([]);
      if (piece) lines[lines.length - 1].push({ text: piece, cls: tok.cls });
    });
  }
  return lines;
}

function Tree({ nodes, depth, open, onToggle, selected, onSelect }: {
  nodes: Node[];
  depth: number;
  open: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
        const pad = { paddingLeft: 8 + depth * 16 };
        if (n.children) {
          const isOpen = open.has(n.path);
          return (
            <div key={n.path}>
              <button
                type="button"
                onClick={() => onToggle(n.path)}
                aria-expanded={isOpen}
                style={pad}
                className="w-full flex items-center gap-1.5 h-8 pr-2 rounded-[6px] text-left text-[14px] text-text-100 hover:bg-bg-200/60"
              >
                <Folder className="w-4 h-4 shrink-0 text-text-300" />
                <span className="flex-1 min-w-0 truncate">{n.name}</span>
                {isOpen ? <ChevronDown className="w-4 h-4 shrink-0 text-text-400" /> : <ChevronRight className="w-4 h-4 shrink-0 text-text-400" />}
              </button>
              {isOpen && <Tree nodes={n.children} depth={depth + 1} open={open} onToggle={onToggle} selected={selected} onSelect={onSelect} />}
            </div>
          );
        }
        return (
          <button
            key={n.path}
            type="button"
            onClick={() => onSelect(n.path)}
            aria-current={selected === n.path}
            style={{ paddingLeft: 8 + depth * 16 + (depth > 0 ? 6 : 0) }}
            className={cn(
              "w-full flex items-center h-8 pr-2 rounded-[6px] text-left text-[14px] truncate",
              selected === n.path ? "bg-bg-200 text-text-100 font-medium" : "text-text-200 hover:bg-bg-200/60",
            )}
          >
            <span className="truncate">{n.name}</span>
          </button>
        );
      })}
    </>
  );
}

type Shown =
  | { kind: "text"; text: string }
  | { kind: "image"; src: string }
  | { kind: "none" };

function FileView({ root, path }: { root: string; path: string }) {
  const t = useTranslations().customizePage;
  const [shown, setShown] = useState<{ path: string; value: Shown } | null>(null);
  const [rendered, setRendered] = useState(true);
  const full = `${root.replace(/[\\/]+$/, "")}/${path}`;

  useEffect(() => {
    let alive = true;
    (async () => {
      let value: Shown;
      try {
        if (IMAGE.test(path)) {
          const img = await invoke<{ base64: string; mediaType: string }>("agent_read_image", { path: full });
          value = { kind: "image", src: `data:${img.mediaType};base64,${img.base64}` };
        } else {
          const read = await invoke<{ text: string } | null>("agent_read_text", { path: full, withEncoding: true });
          value = read ? { kind: "text", text: read.text.replace(/\r\n?/g, "\n") } : { kind: "none" };
        }
      } catch {
        value = { kind: "none" };
      }
      if (alive) setShown({ path, value });
    })();
    return () => { alive = false; };
  }, [full, path]);

  const value = shown?.path === path ? shown.value : null;
  const markdown = MARKDOWN.test(path);
  const text = value?.kind === "text" ? value.text : "";
  const all = useMemo(() => text.split("\n"), [text]);
  const cut = all.length > MAX_LINES;
  const lines = useMemo(
    () => (text ? toLines(tokenize(all.slice(0, MAX_LINES).join("\n"), langFromPath(path))) : []),
    [text, all, path],
  );

  return (
    <div className="flex flex-col min-w-0 min-h-0">
      <div className="flex items-center gap-2 h-11 shrink-0 pl-4 pr-2">
        <span className="flex-1 min-w-0 truncate font-mono text-[13px] text-text-400">/{path}</span>
        {markdown && value?.kind === "text" && (
          <div className="flex items-center rounded-[6px] border border-bg-300 p-0.5">
            <button
              type="button"
              onClick={() => setRendered(true)}
              aria-label={t.preview}
              aria-pressed={rendered}
              className={cn("w-7 h-6 rounded-[4px] flex items-center justify-center", rendered ? "bg-bg-200 text-text-100" : "text-text-400 hover:text-text-100")}
            >
              <Eye className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setRendered(false)}
              aria-label={t.viewSource}
              aria-pressed={!rendered}
              className={cn("w-7 h-6 rounded-[4px] flex items-center justify-center", !rendered ? "bg-bg-200 text-text-100" : "text-text-400 hover:text-text-100")}
            >
              <CodeXml className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {!value ? (
          <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-text-400">
            <Loader2 className="w-4 h-4 animate-spin" /> {t.loading}
          </div>
        ) : value.kind === "none" ? (
          <p className="px-4 py-6 text-[13px] text-text-400">{t.fileUnreadable}</p>
        ) : value.kind === "image" ? (
          <div className="p-4">
            <img src={value.src} alt={path} className="max-w-full rounded-[6px] border border-bg-300" />
          </div>
        ) : markdown && rendered ? (
          <div className="px-5 pb-6 text-[14px] text-text-100 min-w-0">
            <MarkdownText text={text} />
          </div>
        ) : (
          <div className="pb-4 font-mono text-[12.5px] leading-[1.75]">
            {lines.map((line, i) => (
              <div key={i} className="flex">
                <span className="w-12 shrink-0 pr-4 text-right text-text-400 select-none tabular-nums">{i + 1}</span>
                <span className="flex-1 min-w-0 pr-4 whitespace-pre-wrap break-words text-text-100">
                  {line.map((tok, j) => <span key={j} className={tok.cls}>{tok.text}</span>)}
                </span>
              </div>
            ))}
            {cut && <p className="px-4 pt-3 font-sans text-[13px] text-text-400">{t.fileTooLong.replace("{n}", String(MAX_LINES))}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/** A plugin's files, as Claude shows them: the version on top, the tree on the left and the
 *  chosen file on the right, a README rendered (or as text). */
export function PluginFiles({
  root,
  title,
  installedAt,
  onCount,
  onOpenFolder,
}: {
  root: string;
  /** "name version", for the line above the files. */
  title: string;
  installedAt?: number;
  onCount?: (n: number) => void;
  onOpenFolder: () => void;
}) {
  const t = useTranslations().customizePage;
  const [paths, setPaths] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const boxRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  // The box reaches down to the bottom of the page, as Claude's does, and follows the window.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const scroller = box?.closest<HTMLElement>("#customize-scroll");
    if (!box || !scroller) return;
    const fit = () => {
      const top = box.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setHeight(Math.max(MIN_HEIGHT, Math.floor(scroller.clientHeight - top - FILES_BOTTOM_GAP)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    void listPluginFiles(root).then((list) => {
      if (!alive) return;
      setPaths(list);
      setSelected(firstFile(list));
      // The first level of folders starts open, as in Claude's tree.
      setOpen(new Set(list.filter((p) => p.includes("/")).map((p) => p.split("/")[0])));
      onCount?.(list.length);
    });
    return () => { alive = false; };
  }, [root, onCount]);

  const tree = useMemo(() => buildTree(paths ?? []), [paths]);
  const date = installedAt
    ? new Date(installedAt).toLocaleDateString(getLanguage(), { day: "numeric", month: "short" })
    : null;

  const toggle = (path: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <span className="inline-flex items-center h-8 px-3 rounded-[6px] bg-bg-200 text-[14px] text-text-100">
          {title}
          {date && <span className="text-text-400">&nbsp;· {t.installedOn.replace("{date}", date)}</span>}
        </span>
        <button
          type="button"
          onClick={onOpenFolder}
          aria-label={t.openFolder}
          className="ml-auto w-8 h-8 rounded-[6px] flex items-center justify-center text-text-300 hover:bg-bg-200 hover:text-text-100"
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
      <div ref={boxRef} style={{ height: height ?? MIN_HEIGHT }}>
      {paths === null ? (
        <div className="flex items-center gap-2 py-16 justify-center text-[13px] text-text-400">
          <Loader2 className="w-4 h-4 animate-spin" /> {t.loading}
        </div>
      ) : (
        <div className="grid grid-cols-[240px_minmax(0,1fr)] h-full rounded-[8px] border border-bg-300 overflow-hidden">
          <div className="border-r border-bg-300 overflow-y-auto custom-scrollbar p-2">
            <Tree nodes={tree} depth={0} open={open} onToggle={toggle} selected={selected} onSelect={setSelected} />
          </div>
          {selected ? (
            <FileView key={selected} root={root} path={selected} />
          ) : (
            <p className="p-6 text-[13px] text-text-400">{t.pickFile}</p>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
