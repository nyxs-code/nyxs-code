import { useCallback, useState } from "react";
import { flushSave } from "@/lib/video/timelineStore";
import { revalidatePlayer } from "./playerClient";
import { convertToLight, deleteProject, duplicateProject, renameProject, revealProject, type VideoProjectInfo } from "@/lib/video/videoApi";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Options {
  workspace: string | null;
  /** The localized name of a copy, e.g. "Intro (copia)". */
  copyName: (name: string) => string;
  refresh: () => Promise<void>;
  openSlug: string | null;
  open: (slug: string | null) => void;
}

/** Rename, duplicate, show in folder, delete (after a confirmation) and convert, for the
 *  picker's cards and the editor's ⋯ menu. The list refreshes after each change. */
export function useProjectActions({ workspace, copyName, refresh, openSlug, open }: Options) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<VideoProjectInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped when the open project's player server may have been stopped: the editor asks for it
   *  again. */
  const [serverEpoch, setServerEpoch] = useState(0);

  const revalidateIfOpen = useCallback(
    async (slug: string) => {
      if (!workspace || openSlug !== slug) return;
      await revalidatePlayer(workspace, slug);
      setServerEpoch((n) => n + 1);
    },
    [workspace, openSlug],
  );

  const run = useCallback(
    async (slug: string, fn: () => Promise<void>) => {
      setBusy(slug);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const rename = useCallback(
    (p: VideoProjectInfo, name: string) => {
      setRenaming(null);
      const clean = name.trim();
      if (!workspace || !clean || clean === p.name) return;
      void run(p.slug, async () => {
        // A debounced save still pending would land in the old folder after the move.
        if (openSlug === p.slug) await flushSave();
        const info = await renameProject(workspace, p.slug, clean);
        await refresh();
        // The folder follows the name when that slug is free, and the backend stops the player
        // first: the editor moves to the new slug, or (the move failed) gets its server back.
        if (openSlug === p.slug && info.slug !== p.slug) open(info.slug);
        else await revalidateIfOpen(p.slug);
      });
    },
    [workspace, run, refresh, openSlug, open, revalidateIfOpen],
  );

  const duplicate = useCallback(
    (p: VideoProjectInfo) => {
      if (!workspace) return;
      void run(p.slug, async () => {
        await duplicateProject(workspace, p.slug, copyName(p.name));
        await refresh();
      });
    },
    [workspace, copyName, run, refresh],
  );

  const reveal = useCallback(
    (p: VideoProjectInfo) => {
      if (workspace) void revealProject(workspace, p.slug).catch((e) => setError(errText(e)));
    },
    [workspace],
  );

  const convert = useCallback(
    (p: VideoProjectInfo) => {
      if (!workspace) return;
      void run(p.slug, async () => {
        if (openSlug === p.slug) await flushSave();
        await convertToLight(workspace, p.slug);
        await refresh();
        // The conversion stopped the player, which ran from the project's node_modules.
        await revalidateIfOpen(p.slug);
      });
    },
    [workspace, run, refresh, openSlug, revalidateIfOpen],
  );

  /** Called by the confirmation dialog. */
  const deleteConfirmed = useCallback(() => {
    const p = confirmDelete;
    setConfirmDelete(null);
    if (!workspace || !p) return;
    void run(p.slug, async () => {
      // Closed first: its player server and file watcher hold the folder on Windows.
      if (openSlug === p.slug) open(null);
      await deleteProject(workspace, p.slug);
      await refresh();
    });
  }, [confirmDelete, workspace, run, openSlug, open, refresh]);

  return {
    renaming,
    startRename: setRenaming,
    cancelRename: () => setRenaming(null),
    rename,
    duplicate,
    reveal,
    convert,
    requestDelete: setConfirmDelete,
    confirmDelete,
    cancelDelete: () => setConfirmDelete(null),
    deleteConfirmed,
    busy,
    serverEpoch,
    error,
    clearError: () => setError(null),
  };
}

export type ProjectActions = ReturnType<typeof useProjectActions>;
