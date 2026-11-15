import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Search,
  Loader2,
  Folder,
  ListTree,
  Clapperboard,
} from "lucide-react";
import "@vscode/codicons/dist/codicon.css";
import { invoke } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { localizedError, useTranslations } from "@/lib/i18n";
import { subscribeFsChange } from "@/lib/fsWatch";
import { OPEN_FILE_EVENT, takePendingFile } from "@/lib/filePaths";
import { setViewCloseGuard } from "@/lib/viewCloseGuard";
import type { LeaveGuard } from "./FileEditor";
import { FileIcon } from "./FileIcon";
import { FilePreview } from "./FilePreview";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import { EditInVideoMenu } from "../video/EditInVideoMenu";
import { requestEditVideoFile, VIDEO_FILE_RE } from "../video/editVideoFile";

interface FsEntry { name: string; isDir: boolean; }

interface OpenFile { path: string; rel: string; }

// agent_list_dir appends "  (1.8 KB)" to files for the agent's benefit; the tree only wants the name.
const SIZE_SUFFIX = / {2}\([\d.]+ [KMGT]?B\)$/;

function parseEntry(n: string): FsEntry {
  return n.endsWith("/") ? { name: n.slice(0, -1), isDir: true } : { name: n.replace(SIZE_SUFFIX, ""), isDir: false };
}

function sortEntries(es: FsEntry[]): FsEntry[] {
  return [...es].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent.replace(/[\\/]+$/, "") + sep + name;
}

function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\") || p.startsWith("ssh://");
}

function relativeTo(workspace: string, full: string): string {
  const base = workspace.replace(/[\\/]+$/, "");
  return full.toLowerCase().startsWith(base.toLowerCase()) ? full.slice(base.length).replace(/^[\\/]+/, "") : full;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

interface TreeProps {
  fullPath: string;
  rel: string;
  name: string;
  isDir: boolean;
  depth: number;
  refreshKey: number;
  selected: string | null;
  onOpen: (f: OpenFile) => void;
}

function FileTreeNode({ fullPath, rel, name, isDir, depth, refreshKey, selected, onOpen }: TreeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const [videoMenu, setVideoMenu] = useState<{ x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const e = await invoke<string[]>("agent_list_dir", { path: fullPath });
      const next = sortEntries(e.map(parseEntry));

      setChildren((prev) =>
        prev && prev.length === next.length && prev.every((p, i) => p.name === next[i].name && p.isDir === next[i].isDir)
          ? prev
          : next,
      );
    } catch {
      setChildren([]);
    }
  }, [fullPath]);

  const click = async () => {
    if (!isDir) { onOpen({ path: fullPath, rel }); return; }
    const next = !open;
    setOpen(next);
    if (next && children === null) await load();
  };

  useEffect(() => {
    if (refreshKey === 0 || !open) return;
    void Promise.resolve().then(load);
  }, [refreshKey, open, load]);

  return (
    <>
      <button
        onClick={click}
        onContextMenu={!isDir && VIDEO_FILE_RE.test(name) ? (e) => { e.preventDefault(); setVideoMenu({ x: e.clientX, y: e.clientY }); } : undefined}
        style={{ paddingLeft: depth * 12 + 8 }}
        className={cn(
          "w-full flex items-center gap-2 py-[5px] pr-2 rounded-md text-[13px] text-left text-text-200 transition-colors",
          selected === fullPath ? "bg-bg-200 text-text-100" : "hover:bg-bg-200/70",
        )}
      >
        {isDir ? (
          <i
            aria-hidden
            className={cn("codicon w-4 h-4 shrink-0 text-text-400", open ? "codicon-chevron-down" : "codicon-chevron-right")}
          />
        ) : (
          <FileIcon name={name} />
        )}
        <span className="truncate">{name}</span>
      </button>
      {videoMenu && <EditInVideoMenu x={videoMenu.x} y={videoMenu.y} path={fullPath} onClose={() => setVideoMenu(null)} />}
      {isDir && open && children?.map((c) => (
        <FileTreeNode
          key={c.name}
          fullPath={joinPath(fullPath, c.name)}
          rel={`${rel}/${c.name}`}
          name={c.name}
          isDir={c.isDir}
          depth={depth + 1}
          refreshKey={refreshKey}
          selected={selected}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

export function FilesView({ workspace }: { workspace: string | null }) {
  const t = useTranslations().views;
  const tVideo = useTranslations().videoPanel;
  const [query, setQuery] = useState("");
  const [roots, setRoots] = useState<FsEntry[]>([]);
  const [matches, setMatches] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpenFile] = useState<OpenFile | null>(null);
  const [showTree, setShowTree] = useState(true);

  const [refreshKey, setRefreshKey] = useState(0);

  // Leaving the open file (another one opened, the file or the panel closed) asks first when its
  // changes aren't saved and auto save is off: `leaving` is the step waiting on the answer.
  const guardRef = useRef<LeaveGuard | null>(null);
  const onLeaveGuard = useCallback((guard: LeaveGuard | null) => { guardRef.current = guard; }, []);
  const [leaving, setLeaving] = useState<{ name: string; go: () => void; cancel?: () => void } | null>(null);
  const [savingToLeave, setSavingToLeave] = useState(false);
  const leave = (go: () => void, cancel?: () => void) => {
    if (guardRef.current?.unsaved && opened) setLeaving({ name: baseName(opened.rel), go, cancel });
    else go();
  };
  const leaveRef = useRef(leave);
  useEffect(() => { leaveRef.current = leave; });
  useEffect(() => {
    setViewCloseGuard("files", (close, cancel) => leaveRef.current(close, cancel));
    return () => setViewCloseGuard("files", null);
  }, []);
  const openOther = (f: OpenFile) => {
    if (f.path !== opened?.path) leave(() => setOpenFile(f));
  };
  const saveAndLeave = async () => {
    if (!leaving) return;
    setSavingToLeave(true);
    const saved = (await guardRef.current?.save()) ?? false;
    setSavingToLeave(false);
    setLeaving(null);
    // A save that failed or hit a change on disk stays on the file, with the editor saying why.
    if (saved) leaving.go();
    else leaving.cancel?.();
  };

  // A file path clicked in the chat: opened here, whether the panel was open or just opened.
  useEffect(() => {
    if (!workspace) return;
    const show = (full: string | null) => {
      if (!full) return;
      const file = { path: full, rel: relativeTo(workspace, full).replace(/\\/g, "/") };
      leaveRef.current(() => setOpenFile(file));
    };
    show(takePendingFile());
    const onFile = () => show(takePendingFile());
    window.addEventListener(OPEN_FILE_EVENT, onFile);
    return () => window.removeEventListener(OPEN_FILE_EVENT, onFile);
  }, [workspace]);

  // A file opened in another workspace is dropped when the folder changes.
  const openFile = opened && workspace && opened.path.toLowerCase().startsWith(workspace.toLowerCase()) ? opened : null;

  if (!workspace && roots.length > 0) setRoots([]);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    invoke<string[]>("agent_list_dir", { path: workspace })
      .then((e) => {
        if (!alive) return;
        const next = sortEntries(e.map(parseEntry));
        setRoots((prev) =>
          prev.length === next.length && prev.every((p, i) => p.name === next[i].name && p.isDir === next[i].isDir)
            ? prev
            : next,
        );
        setError("");
      })
      .catch((e) => { if (alive) setError(localizedError(e)); });
    return () => { alive = false; };
  }, [workspace, refreshKey]);

  useEffect(() => {
    if (!workspace) return;
    const bump = () => setRefreshKey((k) => k + 1);
    const unsub = subscribeFsChange(workspace, bump);
    window.addEventListener("focus", bump);
    return () => {
      window.removeEventListener("focus", bump);
      unsub();
    };
  }, [workspace]);

  const searchKey = `${workspace ?? ""}|${query.trim()}`;
  const [lastSearchKey, setLastSearchKey] = useState(searchKey);
  if (searchKey !== lastSearchKey) {
    setLastSearchKey(searchKey);
    const active = !!query.trim() && !!workspace;
    setSearching(active);
    if (!active) setMatches(null);
  }

  useEffect(() => {
    const q = query.trim();
    if (!q || !workspace) return;
    let alive = true;
    const handle = setTimeout(async () => {
      try {
        if (q.startsWith("?")) {
          const pattern = q.slice(1).trim();
          if (!pattern) { if (alive) { setMatches(null); setSearching(false); } return; }
          const res = await invoke<string>("agent_grep", {
            pattern, cwd: workspace, outputMode: "files_with_matches", caseInsensitive: true,
          });
          if (alive) setMatches(res.split("\n").map((s) => s.trim()).filter((s) => s && s !== "No matches."));
        } else {
          const all = await invoke<string[]>("agent_list_files", { workspace });
          const lc = q.toLowerCase();
          if (alive) setMatches(all.filter((p) => p.toLowerCase().includes(lc)).slice(0, 500));
        }
      } catch (e) {
        if (alive) { setMatches([]); setError(localizedError(e)); }
      } finally {
        if (alive) setSearching(false);
      }
    }, 250);
    return () => { alive = false; clearTimeout(handle); };
  }, [query, workspace]);

  if (!workspace) {
    return <div className="flex items-center justify-center h-full text-sm text-text-400">{t.noWorkingFolder}</div>;
  }

  const filtering = query.trim().length > 0;
  const selected = openFile?.path ?? null;

  const openMatch = (m: string) => {
    const full = isAbsolute(m) ? m : joinPath(workspace, m.replace(/[\\/]/g, workspace.includes("\\") ? "\\" : "/"));
    openOther({ path: full, rel: relativeTo(workspace, full).replace(/\\/g, "/") });
  };

  const tree = (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-bg-200/60 border border-bg-300 focus-within:border-accent transition-colors">
          <Search className="w-3.5 h-3.5 text-text-500 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.filterFiles}
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-text-100 placeholder:text-text-500"
            spellCheck={false}
          />
          {query && (
            <button onClick={() => setQuery("")} className="shrink-0 text-text-500 hover:text-text-200" aria-label="clear">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar px-1.5 pb-1.5">
        {error && <p className="text-[12px] text-red-400 px-2 py-1">{error}</p>}
        {filtering ? (
          searching ? (
            <p className="flex items-center gap-2 text-[12px] text-text-500 px-2 py-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /></p>
          ) : matches && matches.length > 0 ? (
            matches.map((m) => {
              const rel = isAbsolute(m) ? relativeTo(workspace, m) : m;
              return (
                <button
                  key={m}
                  onClick={() => openMatch(m)}
                  className="w-full flex items-center gap-2 py-[5px] pl-2 pr-2 rounded-md text-[13px] text-left text-text-200 hover:bg-bg-200/70"
                >
                  <FileIcon name={baseName(rel)} />
                  <span className="truncate">{rel}</span>
                </button>
              );
            })
          ) : (
            <p className="text-[12px] text-text-500 px-2 py-1">{t.noMatches}</p>
          )
        ) : (
          <>
            {roots.map((c) => (
              <FileTreeNode
                key={c.name}
                fullPath={joinPath(workspace, c.name)}
                rel={c.name}
                name={c.name}
                isDir={c.isDir}
                depth={0}
                refreshKey={refreshKey}
                selected={selected}
                onOpen={openOther}
              />
            ))}
            {roots.length === 0 && !error && <p className="text-[12px] text-text-500 px-2 py-1">{t.empty}</p>}
          </>
        )}
      </div>
    </div>
  );

  // The tree keeps the same position in both layouts so expanded folders survive opening a file.
  return (
    <div className="flex flex-col h-full">
      {openFile && <div className="flex items-center gap-1.5 px-2 pb-1.5 border-b border-bg-300">
        <button
          onClick={() => setShowTree((v) => !v)}
          aria-label={t.toggleFileTree}
          data-tooltip={t.toggleFileTree}
          className={cn(
            "shrink-0 p-1 rounded-md transition-colors",
            showTree ? "bg-accent/15 text-accent" : "text-text-400 hover:text-text-200 hover:bg-bg-200",
          )}
        >
          <ListTree className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-1.5 min-w-0 pl-2 pr-1 py-1 rounded-md bg-bg-200 text-[12px] text-text-100">
          <FileIcon name={baseName(openFile.rel)} className="!w-3.5 !h-3.5" />
          <span className="truncate italic">{baseName(openFile.rel)}</span>
          <button
            onClick={() => leave(() => setOpenFile(null))}
            aria-label={t.close}
            className="shrink-0 p-0.5 rounded text-text-400 hover:text-text-100 hover:bg-bg-300"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
        {VIDEO_FILE_RE.test(openFile.path) && (
          <button
            onClick={() => requestEditVideoFile(openFile.path)}
            className="ml-auto shrink-0 flex items-center gap-1.5 h-6 px-2 rounded-md text-[12px] text-text-300 hover:text-text-100 hover:bg-bg-200"
          >
            <Clapperboard className="w-3.5 h-3.5" />
            {tVideo.editInVideo}
          </button>
        )}
      </div>}
      <div className="flex flex-1 min-h-0">
        <div className={cn("min-h-0", !openFile || showTree ? "w-[240px] shrink-0 border-r border-bg-300" : "hidden")}>
          {tree}
        </div>
        <div className="flex-1 min-w-0">
          {openFile ? (
            <FilePreview path={openFile.path} label={openFile.rel} refreshKey={refreshKey} workspace={workspace} onLeaveGuard={onLeaveGuard} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full px-8 text-center">
              <Folder className="w-5 h-5 mb-3 text-text-400" strokeWidth={1.5} />
              <p className="text-[13px] font-medium text-text-100">{t.filesEmptyTitle}</p>
              <p className="mt-1 max-w-[280px] text-[12px] leading-snug text-text-400">{t.filesEmptyDesc}</p>
            </div>
          )}
        </div>
      </div>
      {leaving && (
        <UnsavedChangesDialog
          name={leaving.name}
          saving={savingToLeave}
          onSave={() => void saveAndLeave()}
          onDiscard={() => {
            setLeaving(null);
            leaving.go();
          }}
          onCancel={() => {
            setLeaving(null);
            leaving.cancel?.();
          }}
        />
      )}
    </div>
  );
}
