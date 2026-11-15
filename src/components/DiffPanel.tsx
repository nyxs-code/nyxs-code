import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  GitBranch,
  ListTree,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { subscribeFsChange, subscribeGitChange } from "@/lib/fsWatch";
import { classifyGitFailure, trustRepository, type GitFailure } from "@/lib/gitErrors";
import { FileIcon } from "@/components/views/FileIcon";
import type { DiffFile } from "./diff/parse";
import { lastLoaded, readChangesShared } from "./diff/load";
import { useDiffMode, type DiffMode } from "@/lib/gitBase";
import { SETTINGS_KEY, TEST_OR_BUILD, loadSettings, type Settings } from "./diff/settings";
import { Counts, LazyBody, SplitBody, UnifiedBody } from "./diff/DiffBody";
import { ReviewBar } from "./diff/DiffComments";
import { sendDiffReview } from "@/lib/diffComments";
import { buildTree, splitPath } from "./diff/tree";
import { TreeItem } from "./diff/FileTree";
import { SettingsMenu } from "./diff/SettingsMenu";

// ── Panel ──────────────────────────────────────────────────────────────────

/** Open the view at this file. `nonce` changes on every request so the same file can be asked
 *  for twice. */
export interface DiffFocus {
  path: string;
  nonce: number;
}

/** Whether a git path (relative to the repo, forward slashes) is this absolute path. */
function sameFile(gitPath: string, absPath: string): boolean {
  const abs = absPath.replace(/\\/g, "/").toLowerCase();
  const rel = gitPath.replace(/\\/g, "/").toLowerCase();
  return abs === rel || abs.endsWith(`/${rel}`);
}

export function DiffPanel({
  workspace,
  refreshKey = 0,
  focus,
  onClose,
  onToggleMaximize,
  maximized = false,
}: {
  workspace: string | null;
  refreshKey?: number;
  focus?: DiffFocus | null;
  onClose?: () => void;
  onToggleMaximize?: () => void;
  maximized?: boolean;
}) {
  const t = useTranslations().views;
  const tComments = useTranslations().diffComments;
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const set = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

  // Shared with the Git bar, per folder: its +N −M is what this panel shows.
  const [diffMode, setDiffMode] = useDiffMode(workspace);
  const cacheKey = workspace ? `${workspace}|${diffMode}` : "";
  const cached = workspace ? lastLoaded.get(cacheKey) : undefined;
  const [files, setFiles] = useState<DiffFile[]>(cached?.files ?? []);
  const [branch, setBranch] = useState(cached?.branch ?? "");
  /** The default branch "All branch changes" compares with; null when there is none to offer. */
  const [baseRef, setBaseRef] = useState<string | null>(cached?.baseRef ?? null);
  /** The mode the shown files were read in ("branch" falls back without a default branch). */
  const [shownMode, setShownMode] = useState<DiffMode>(cached?.mode ?? diffMode);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<GitFailure | null>(null);
  const [trusting, setTrusting] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!workspace) return;
      // With the last result on screen already, it's brought up to date without the spinner.
      const silent = opts?.silent ?? lastLoaded.has(`${workspace}|${diffMode}`);
      if (!silent) setLoading(true);
      try {
        const read = await readChangesShared(workspace, diffMode, settings.hideWhitespace);
        if (!read.ok) {
          setFailure(read.failure);
          setFiles([]);
          setBranch("");
          return;
        }
        const { loaded } = read;
        setBranch(loaded.branch);
        setBaseRef(loaded.baseRef);
        setShownMode(loaded.mode);
        setFailure(null);
        setFiles(loaded.files);
      } catch (e) {
        if (!silent) {
          setFailure(classifyGitFailure(e instanceof Error ? e.message : String(e)));
          setFiles([]);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [workspace, settings.hideWhitespace, diffMode],
  );

  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => { if (alive) void load(); });
    return () => { alive = false; };
  }, [load]);

  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return; }
    const id = setTimeout(() => void load({ silent: true }), 400);
    return () => clearTimeout(id);
  }, [refreshKey, load]);

  useEffect(() => {
    if (!workspace) return;
    const refresh = () => void load({ silent: true });
    const unsub = subscribeFsChange(workspace, refresh);
    const unsubGit = subscribeGitChange(workspace, refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); unsub(); unsubGit(); };
  }, [workspace, load]);

  // Ctrl+Shift+Y shows or hides the file list while this panel is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        set({ showFiles: !settings.showFiles });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set, settings.showFiles]);

  const trust = async (path: string) => {
    setTrusting(true);
    try {
      const res = await trustRepository(path);
      if (res.code !== 0) setFailure({ kind: "other", message: res.stderr.trim() || `git config exit ${res.code}` });
      else await load();
    } finally {
      setTrusting(false);
    }
  };

  // The whole change, whatever the search shows: the same +N −M as the Git bar.
  const totals = useMemo(
    () => files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), { added: 0, removed: 0 }),
    [files],
  );
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files), [files, q]);
  const groups = useMemo(() => {
    if (!settings.separateTests) return [{ key: "main", label: null as string | null, files: shown }];
    const main = shown.filter((f) => !TEST_OR_BUILD.test(f.path));
    const rest = shown.filter((f) => TEST_OR_BUILD.test(f.path));
    return [
      { key: "main", label: null as string | null, files: main },
      ...(rest.length ? [{ key: "tests", label: t.diffTestsGroup as string | null, files: rest }] : []),
    ];
  }, [shown, settings.separateTests, t.diffTestsGroup]);

  const pick = (path: string) => {
    setActive(path);
    setCollapsed((s) => { const n = new Set(s); n.delete(path); return n; });
    // Straight there, no scrolling animation: the user doesn't want one when moving between files.
    requestAnimationFrame(() => sectionRefs.current.get(path)?.scrollIntoView({ block: "start", behavior: "instant" }));
  };

  // Jumps to a requested file once the list has it (the panel may still be loading).
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!focus || handledFocus.current === focus.nonce) return;
    const hit = files.find((f) => sameFile(f.path, focus.path));
    if (!hit) return;
    handledFocus.current = focus.nonce;
    void Promise.resolve().then(() => {
      setQuery("");
      setActive(hit.path);
      setCollapsed((s) => { const n = new Set(s); n.delete(hit.path); return n; });
      requestAnimationFrame(() => sectionRefs.current.get(hit.path)?.scrollIntoView({ block: "start", behavior: "instant" }));
    });
  }, [focus, files]);

  const toggleFile = (path: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; });

  if (!workspace) {
    return <div className="flex items-center justify-center h-full text-sm text-text-400">{t.noWorkingFolder}</div>;
  }

  const iconBtn = "p-1.5 rounded-md text-text-400 hover:text-text-100 hover:bg-bg-200 transition-colors";

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onKeyDown={(e) => {
        // Ctrl+Enter anywhere in the panel sends the line comments, like Claude Code Desktop.
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && sendDiffReview(workspace, tComments)) e.preventDefault();
      }}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-bg-300 shrink-0">
        <button
          type="button"
          onClick={() => set({ showFiles: !settings.showFiles })}
          aria-pressed={settings.showFiles}
          aria-label={t.diffShowFiles}
          data-tooltip={t.diffShowFiles}
          data-tooltip-kbd="Ctrl+Shift+Y"
          className={cn("p-1.5 rounded-md transition-colors", settings.showFiles ? "bg-accent/15 text-accent" : "text-text-400 hover:text-text-100 hover:bg-bg-200")}
        >
          <ListTree className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-1.5 min-w-0 px-2 text-[13px] text-text-200">
          <GitBranch className="w-3.5 h-3.5 shrink-0 text-text-400" />
          <span className="truncate">{branch || "—"}</span>
          {!baseRef && (
            <>
              <ArrowRight className="w-3.5 h-3.5 shrink-0 text-text-400" />
              <span className="truncate text-text-300">{t.diffWorkingTree}</span>
            </>
          )}
          {loading && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-text-400" />}
        </div>
        {baseRef && (
          <div role="radiogroup" aria-label={t.diffCompare} className="flex shrink-0 items-center gap-0.5 rounded-[6px] bg-bg-200 p-0.5">
            {(["uncommitted", "branch"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={shownMode === m}
                onClick={() => setDiffMode(m)}
                data-tooltip={m === "branch" ? t.diffModeBranchHint.replace("{base}", baseRef.replace(/^origin\//, "")) : t.diffModeUncommittedHint}
                className={cn(
                  "h-6 px-2 rounded-[4px] text-[12px] whitespace-nowrap transition-colors",
                  shownMode === m ? "bg-bg-0 text-text-100 shadow-sm" : "text-text-400 hover:text-text-100",
                )}
              >
                {m === "branch" ? t.diffModeBranch : t.diffModeUncommitted}
              </button>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <span className="shrink-0 px-1.5 text-[12px]" aria-label={t.diffTotals.replace("{added}", String(totals.added)).replace("{removed}", String(totals.removed))}>
            <Counts added={totals.added} removed={totals.removed} />
          </span>
        )}
        <span className="flex-1" />
        {searching && (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setSearching(false); } }}
            placeholder={t.diffSearchFiles}
            className="w-44 min-w-0 rounded-md border border-bg-300 bg-bg-100 px-2 py-1 text-[12px] text-text-100 placeholder:text-text-500 focus:border-accent focus:outline-none"
          />
        )}
        <button
          type="button"
          onClick={() => { setSearching((v) => !v); if (searching) setQuery(""); }}
          aria-label={t.diffSearchFiles}
          data-tooltip={t.diffSearchFiles}
          className={cn(iconBtn, searching && "bg-bg-200 text-text-100")}
        >
          <Search className="w-4 h-4" />
        </button>
        <SettingsMenu
          settings={settings}
          set={set}
          onCollapseAll={() => setCollapsed(new Set(files.map((f) => f.path)))}
          onExpandAll={() => setCollapsed(new Set())}
          onRefresh={() => void load()}
        />
        {onToggleMaximize && (
          <button type="button" onClick={onToggleMaximize} aria-label={maximized ? t.showChat : t.diffExpandPanel} data-tooltip={maximized ? t.showChat : t.diffExpandPanel} className={iconBtn}>
            {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose} aria-label={t.close} data-tooltip={t.close} className={iconBtn}>
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <ReviewBar workspace={workspace} />

      {failure ? (
        <div className="flex flex-col items-center justify-center flex-1 text-center px-6 gap-2">
          <GitBranch className="w-7 h-7 text-text-500" />
          {failure.kind === "untrusted" ? (
            <>
              <p className="text-sm text-text-300">{t.diffUntrusted}</p>
              <button
                onClick={() => void trust(failure.path)}
                disabled={trusting}
                className="mt-1 px-3 py-1.5 rounded-md text-[13px] bg-bg-200 hover:bg-bg-300 text-text-100 disabled:opacity-60"
              >
                {trusting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t.diffTrustFolder}
              </button>
              <p className="text-[12px] text-text-500 font-mono">git config --global --add safe.directory {failure.path}</p>
            </>
          ) : failure.kind === "missing-git" ? (
            <p className="text-sm text-text-300">{t.diffGitMissing}</p>
          ) : failure.kind === "other" ? (
            <>
              <p className="text-sm text-text-300">{t.diffGitError}</p>
              <pre className="max-w-full whitespace-pre-wrap text-left text-[12px] text-text-400 font-mono">{failure.message}</pre>
            </>
          ) : (
            <p className="text-sm text-text-300">{t.diffNotRepo}</p>
          )}
        </div>
      ) : files.length === 0 && !loading ? (
        <div className="flex flex-col items-center justify-center flex-1 text-center px-6">
          <GitBranch className="w-7 h-7 text-text-500 mb-2" />
          <p className="text-sm text-text-300">{t.diffNoChanges}</p>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {settings.showFiles && (
            <div className="w-60 shrink-0 border-r border-bg-300 overflow-y-auto custom-scrollbar py-1.5 px-1">
              {groups.map((g) => (
                <div key={g.key} className={cn(g.label && "mt-2 pt-2 border-t border-bg-300")}>
                  {g.label && <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-500">{g.label}</p>}
                  {settings.groupByFolder
                    ? buildTree(g.files).map((n) => <TreeItem key={n.path} node={n} depth={0} onPick={pick} active={active} />)
                    : g.files.map((f) => {
                        const { name, dir } = splitPath(f.path);
                        return (
                          <button
                            key={f.path}
                            type="button"
                            onClick={() => pick(f.path)}
                            className={cn(
                              "w-full flex items-center gap-1.5 py-[3px] px-2 rounded-md text-left text-[13px] transition-colors",
                              active === f.path ? "bg-bg-200 text-text-100" : "text-text-200 hover:bg-bg-200/70",
                            )}
                          >
                            <FileIcon name={name} className="!w-3.5 !h-3.5" />
                            <span className="min-w-0 flex-1 truncate">
                              {name}
                              {dir && <span className="ml-1.5 text-text-500">{dir}</span>}
                            </span>
                            <Counts added={f.added} removed={f.removed} />
                          </button>
                        );
                      })}
                </div>
              ))}
            </div>
          )}

          <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto custom-scrollbar">
            {groups.map((g) => (
              <Fragment key={g.key}>
                {g.label && <p className="px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-500">{g.label}</p>}
                {g.files.map((f) => {
                  const { name, dir } = splitPath(f.path);
                  const isOpen = !collapsed.has(f.path);
                  return (
                    <div
                      key={f.path}
                      ref={(el) => { if (el) sectionRefs.current.set(f.path, el); else sectionRefs.current.delete(f.path); }}
                      className="border-b border-bg-300"
                    >
                      <button
                        type="button"
                        onClick={() => toggleFile(f.path)}
                        aria-expanded={isOpen}
                        className="sticky top-0 z-10 w-full flex items-center gap-2 px-3 py-1.5 text-left bg-bg-200/90 backdrop-blur-sm hover:bg-bg-200 transition-colors"
                      >
                        <ChevronRight className={cn("w-3.5 h-3.5 shrink-0 text-text-400 transition-transform", isOpen && "rotate-90")} />
                        <FileIcon name={name} className="!w-3.5 !h-3.5" />
                        <span className="min-w-0 truncate text-[13px] text-text-100">
                          {name}
                          {dir && <span className="ml-1.5 text-[12px] text-text-400">{dir}</span>}
                        </span>
                        <Counts added={f.added} removed={f.removed} />
                      </button>
                      {isOpen &&
                        (f.binary || f.missing ? (
                          <p className="px-4 py-3 text-[12px] text-text-400">{f.binary ? t.diffBinary : t.diffTooLarge}</p>
                        ) : (
                          <LazyBody file={f} root={scrollRef}>
                            {() =>
                              settings.sideBySide ? (
                                <SplitBody file={f} settings={settings} workspace={workspace} />
                              ) : (
                                <UnifiedBody file={f} settings={settings} workspace={workspace} />
                              )
                            }
                          </LazyBody>
                        ))}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default DiffPanel;
