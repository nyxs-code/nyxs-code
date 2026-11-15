import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Clapperboard, ExternalLink, Loader2, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { accountKey } from "@/lib/accountScope";
import { subscribeFsChange } from "@/lib/fsWatch";
import { useTranslations } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/openExternal";
import { OPEN_VIDEO_EVENT, takePendingVideoOpen, type VideoOpenRequest } from "@/lib/video/videoOpen";
import {
  adoptProject,
  checkEnv,
  createFromMedia,
  createProject,
  install,
  listProjects,
  onThumbnailReady,
  type VideoEnv,
  type VideoPreset,
  type VideoProjectInfo,
} from "@/lib/video/videoApi";
import { Button } from "@/components/ui/button";
import { EDIT_VIDEO_FILE_EVENT, projectOwningFile, takePendingEditVideoFile } from "./editVideoFile";
import { pathsOfDroppedFiles } from "./media";
import { NewVideoDialog } from "./NewVideoDialog";
import { ProjectPicker, type PendingProject, type ThumbUpdates } from "./ProjectPicker";
import { VideoEditor, type EditorStart } from "./VideoEditor";
import { useProjectActions } from "./useProjectActions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useVideoRuntime } from "./runtimeState";
import { RuntimePreparing } from "./VideoRuntime";

const OPEN_KEY = "nyxs.video.open";
const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "mkv", "avi", "m4v"];

/** The project each workspace had open, so the view comes back to it. */
function loadOpen(workspace: string): string | null {
  try {
    const map = JSON.parse(localStorage.getItem(accountKey(OPEN_KEY)) ?? "{}") as Record<string, string>;
    return map[workspace] ?? null;
  } catch {
    return null;
  }
}

function saveOpen(workspace: string, slug: string | null) {
  try {
    const map = JSON.parse(localStorage.getItem(accountKey(OPEN_KEY)) ?? "{}") as Record<string, string>;
    if (slug) map[workspace] = slug;
    else delete map[workspace];
    localStorage.setItem(accountKey(OPEN_KEY), JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

/** Node.js is checked once per run of the app; "Check again" asks again. */
let envCache: Promise<VideoEnv> | null = null;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Props {
  workspace: string | null;
  chatId?: string;
  onClose: () => void;
  onToggleMaximize: () => void;
  maximized: boolean;
  /** False while the panel keeps it mounted but out of sight. */
  visible?: boolean;
}

/** The Video view of the right-hand panel: the project picker, then the editor. */
export function VideoView({ workspace, chatId, onClose, onToggleMaximize, maximized, visible = true }: Props) {
  const t = useTranslations().videoPanel;
  const [env, setEnv] = useState<VideoEnv | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [projects, setProjects] = useState<VideoProjectInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(() => (workspace ? loadOpen(workspace) : null));
  const [start, setStart] = useState<EditorStart | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [pending, setPending] = useState<PendingProject | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [shownWorkspace, setShownWorkspace] = useState(workspace);
  const [thumbs, setThumbs] = useState<ThumbUpdates>({});

  // Posters render in the background after the list answered (and the first one arrives only
  // this way).
  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;
    void onThumbnailReady(({ slug, path }) =>
      setThumbs((cur) => ({ ...cur, [slug]: { path, version: (cur[slug]?.version ?? 0) + 1 } })),
    ).then((un) => {
      if (cancelled) un();
      else off = un;
    }, () => {});
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // Another workspace: its own last project.
  if (shownWorkspace !== workspace) {
    setShownWorkspace(workspace);
    setThumbs({});
    setOpenSlug(workspace ? loadOpen(workspace) : null);
    setProjects(null);
  }

  // State is only set when the check answers, so this can run from an effect.
  const runEnvCheck = useCallback((force: boolean) => {
    if (force) envCache = null;
    const check = (envCache ??= checkEnv());
    check.then(setEnv, (e) => {
      envCache = null;
      setEnvError(errText(e));
    });
  }, []);
  useEffect(() => runEnvCheck(false), [runEnvCheck]);
  const recheckEnv = () => {
    setEnv(null);
    setEnvError(null);
    runEnvCheck(true);
  };

  // Lists can overlap now the watcher asks for them too: only the newest one counts.
  const listSeq = useRef(0);
  const refresh = useCallback(async () => {
    if (!workspace) return;
    const seq = ++listSeq.current;
    setLoading(true);
    setListError(null);
    try {
      const list = await listProjects(workspace);
      if (seq === listSeq.current) setProjects(list);
    } catch (e) {
      setListError(t.loadFailed.replace("{error}", errText(e)));
      setProjects((cur) => cur ?? []);
    } finally {
      setLoading(false);
    }
  }, [workspace, t.loadFailed]);
  /** A change on disk: no spinner, and a failed look keeps the list that's on screen. */
  const refreshQuietly = useCallback(async () => {
    if (!workspace) return;
    const seq = ++listSeq.current;
    try {
      const list = await listProjects(workspace);
      if (seq === listSeq.current) setProjects((cur) => (JSON.stringify(cur) === JSON.stringify(list) ? cur : list));
    } catch {
      setProjects((cur) => cur ?? []);
    }
  }, [workspace]);
  const envOk = !!env?.node && !!env.npm;
  // The shared video engine (installed once per app, not per video).
  const runtime = useVideoRuntime(!!workspace && envOk);
  const runtimeReady = runtime.phase === "ready";
  useEffect(() => {
    // After the effect, not inside it: refresh sets the loading state right away.
    if (envOk) void Promise.resolve().then(refresh);
  }, [envOk, refresh]);

  const open = useCallback(
    (slug: string | null, at: EditorStart | null = null) => {
      setOpenSlug(slug);
      setStart(at);
      if (workspace) saveOpen(workspace, slug);
    },
    [workspace],
  );

  // The agent's VideoOpen: show that project (and composition/frame).
  useEffect(() => {
    const honor = (req: VideoOpenRequest) => {
      if (req.chat && chatId && req.chat !== chatId) return;
      open(req.slug, { compositionId: req.compositionId, frame: req.frame });
      void refresh();
    };
    const first = takePendingVideoOpen(chatId);
    if (first) honor(first);
    const onEvent = (e: Event) => {
      const req = (e as CustomEvent<VideoOpenRequest>).detail;
      if (!req || (req.chat && chatId && req.chat !== chatId)) return;
      // Taken so a Video view that mounts later doesn't replay it.
      takePendingVideoOpen(chatId);
      honor(req);
    };
    window.addEventListener(OPEN_VIDEO_EVENT, onEvent);
    return () => window.removeEventListener(OPEN_VIDEO_EVENT, onEvent);
  }, [chatId, open, refresh]);

  /** Creating, importing or adopting a project: quick (no npm install per video), but importing
   *  a large file still takes a moment, and a failure needs to show. */
  const runPending = async (name: string, make: () => Promise<VideoProjectInfo>) => {
    setPending({ name, line: null, error: null });
    try {
      const info = await make();
      setPending(null);
      await refresh();
      open(info.slug);
    } catch (e) {
      setPending({ name, line: null, error: errText(e) });
    }
  };

  const runPendingRef = useRef(runPending);
  useEffect(() => { runPendingRef.current = runPending; });

  const createNew = (name: string, preset: VideoPreset) => {
    if (workspace) void runPending(name, () => createProject(workspace, name, preset));
  };

  /** A new project from these files, unless the only one already belongs to a project: then that
   *  project opens (a render in its out/ would otherwise become a second copy of the same video). */
  const projectFromFiles = async (ws: string, paths: string[]): Promise<VideoProjectInfo> => {
    const owner = paths.length === 1 ? projectOwningFile(await listProjects(ws), paths[0]) : null;
    return owner ?? createFromMedia(ws, paths);
  };

  const openVideoFile = async () => {
    if (!workspace) return;
    const picked = await openDialog({ multiple: true, title: t.pickMediaTitle, filters: [{ name: t.filterVideo, extensions: VIDEO_EXTENSIONS }] }).catch(() => null);
    const paths = !picked ? [] : Array.isArray(picked) ? picked : [picked];
    if (!paths.length) return;
    void runPending(baseName(paths[0]), () => projectFromFiles(workspace, paths));
  };

  const openRemotion = async () => {
    if (!workspace) return;
    const picked = await openDialog({ directory: true, title: t.pickRemotionTitle, defaultPath: workspace }).catch(() => null);
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    void runPending(baseName(dir), () => adoptProject(workspace, dir));
  };

  const projectFromFilesRef = useRef(projectFromFiles);
  useEffect(() => { projectFromFilesRef.current = projectFromFiles; });

  const dropFiles = (files: File[]) => {
    if (!workspace || !files.length) return;
    void runPending(files[0].name.replace(/\.[^.]+$/, ""), async () => createFromMedia(workspace, await pathsOfDroppedFiles(workspace, files)));
  };

  // "Edit in Video" from the Files panel: a project made from that file. Waits for Node.js to
  // be known good, so the request isn't lost while the view checks it.
  useEffect(() => {
    if (!workspace || !envOk) return;
    const edit = (path: string) => {
      open(null);
      void runPendingRef.current(baseName(path), () => projectFromFilesRef.current(workspace, [path]));
    };
    const first = takePendingEditVideoFile();
    if (first) edit(first);
    const onEvent = () => {
      const p = takePendingEditVideoFile();
      if (p) edit(p);
    };
    window.addEventListener(EDIT_VIDEO_FILE_EVENT, onEvent);
    return () => window.removeEventListener(EDIT_VIDEO_FILE_EVENT, onEvent);
  }, [workspace, envOk, open]);

  const installProject = async (p: VideoProjectInfo) => {
    if (!workspace) return;
    setInstalling(p.slug);
    try {
      await install(workspace, p.slug);
      await refresh();
    } catch (e) {
      setListError(t.openFailed.replace("{error}", errText(e)));
    } finally {
      setInstalling(null);
    }
  };

  const viewButtons = (
    <>
      <button type="button" onClick={onToggleMaximize} aria-label={maximized ? t.restore : t.maximize} data-tooltip={maximized ? t.restore : t.maximize} className="rounded-[6px] p-1.5 text-text-400 hover:bg-bg-200 hover:text-text-200">
        {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
      <button type="button" onClick={onClose} aria-label={t.close} data-tooltip={t.close} className="rounded-[6px] p-1.5 text-text-400 hover:bg-bg-200 hover:text-text-200">
        <X className="h-4 w-4" />
      </button>
    </>
  );

  const copyName = useCallback((name: string) => t.duplicateName.replace("{name}", name), [t.duplicateName]);
  const actions = useProjectActions({ workspace, copyName, refresh, openSlug, open });
  const deleteDialog = actions.confirmDelete && (
    <ConfirmDialog
      title={t.deleteTitle.replace("{name}", actions.confirmDelete.name)}
      message={(actions.confirmDelete.kind === "remotion" ? t.deleteMessageRemotion : t.deleteMessage).replace("{folder}", actions.confirmDelete.path)}
      confirmLabel={t.deleteProject}
      cancelLabel={t.cancel}
      danger
      onConfirm={actions.deleteConfirmed}
      onCancel={actions.cancelDelete}
    />
  );

  const project = openSlug ? projects?.find((p) => p.slug === openSlug) ?? null : null;
  // A remembered project the list doesn't have shows the picker; if it appears later (the agent
  // just created it) it opens.

  // Only while the picker is what's on screen: each listing can render posters, which the saves
  // of an open editor would keep setting off. Coming back to the picker lists again. A project
  // being created stays out until it's whole; its creator refreshes when done.
  const creating = !!pending && !pending.error;
  const followDisk = visible && !!workspace && envOk && !project && !creating;
  useEffect(() => {
    if (!followDisk || !workspace) return;
    void Promise.resolve().then(refreshQuietly);
    return subscribeFsChange(workspace, () => void refreshQuietly());
  }, [followDisk, workspace, refreshQuietly]);

  if (workspace && envOk && runtimeReady && project) {
    return (
      <>
        <VideoEditor key={`${workspace}|${project.slug}`} workspace={workspace} project={project} start={start} onBack={() => open(null)} viewButtons={viewButtons} projectActions={actions} visible={visible} thumbUpdate={thumbs[project.slug]} chatId={chatId} />
        {deleteDialog}
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 text-[13px] font-medium text-text-100">
          <Clapperboard className="h-4 w-4 text-text-300" />
          <span>{t.title}</span>
        </div>
        <div className="flex items-center gap-0.5">{viewButtons}</div>
      </div>
      <div className="min-h-0 flex-1">
        {!workspace ? (
          <Centered>
            <Clapperboard className="h-6 w-6 text-text-400" />
            <p className="max-w-xs text-[12.5px] leading-relaxed text-text-300">{t.noWorkspace}</p>
          </Centered>
        ) : envError || (env && !envOk) ? (
          <Centered>
            <AlertTriangle className="h-6 w-6 text-amber-500" />
            <p className="text-[13.5px] font-medium text-text-100">{t.nodeMissingTitle}</p>
            <p className="max-w-sm text-[12.5px] leading-relaxed text-text-300">{env?.node && !env.npm ? t.npmMissing : t.nodeMissingBody}</p>
            {envError && <p className="max-w-sm whitespace-pre-wrap font-mono text-[11px] text-text-400">{envError}</p>}
            <div className="mt-1 flex gap-2">
              <Button variant="primary" onClick={() => openExternalUrl("https://nodejs.org/en/download")}>
                <ExternalLink className="h-3.5 w-3.5" />
                {t.nodeDownload}
              </Button>
              <Button variant="secondary" onClick={recheckEnv}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t.checkAgain}
              </Button>
            </div>
          </Centered>
        ) : env && !runtimeReady && runtime.phase !== "checking" ? (
          <RuntimePreparing runtime={runtime} />
        ) : !env || !runtimeReady || (openSlug && projects === null) ? (
          <Centered>
            <Loader2 className="h-5 w-5 animate-spin text-text-400" />
            {!env && <p className="text-[12.5px] text-text-400">{t.checkingEnv}</p>}
          </Centered>
        ) : (
          <ProjectPicker
            projects={projects}
            loading={loading}
            error={listError}
            pending={pending}
            onOpen={(p) => open(p.slug)}
            onInstall={(p) => void installProject(p)}
            installing={installing}
            onNew={() => setNewOpen(true)}
            onOpenVideoFile={() => void openVideoFile()}
            onOpenRemotion={() => void openRemotion()}
            onRefresh={() => void refresh()}
            onDropFiles={dropFiles}
            onDismissPending={() => setPending(null)}
            actions={actions}
            thumbs={thumbs}
          />
        )}
      </div>
      <NewVideoDialog open={newOpen} onClose={() => setNewOpen(false)} onCreate={createNew} />
      {deleteDialog}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">{children}</div>;
}

function baseName(p: string) {
  const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  return name.replace(/\.[^.]+$/, "");
}

export default VideoView;
