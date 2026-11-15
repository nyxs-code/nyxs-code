import { invoke } from "@/lib/ipc";
import { diffLines } from "diff";
import { fileActivity } from "./fileActivity";
import { shadowDiff, shadowSnapshot, type ShadowDiff, type ShadowSnapshot, type ShellChange } from "./shellChanges";

export type BackupFileName = string | null;

export interface FileHistoryBackup {
  backupFileName: BackupFileName;
  version: number;
}

/** How the agent left a file it changed in a turn: the hash of the file right after its last
 *  write (`agent_fh_hash`), or that someone else wrote it in the same stretch, so its content is
 *  partly theirs and a rewind leaves it alone. */
export type LeftAs = { hash: string } | { contested: true };

export interface FileHistorySnapshot {
  messageId: string;
  trackedFileBackups: Record<string, FileHistoryBackup>;
  timestamp: number;
  shellChanges?: ShellChange[];
  /** By the file's absolute path, the files the agent changed in this turn. Present (maybe
   *  empty) in every turn since 2026-10-31; a rewind over an older turn restores as before. */
  leftAs?: Record<string, LeftAs>;
}

function patchSnapshot(update: UpdateFileHistory, messageId: string, fn: (snap: FileHistorySnapshot) => FileHistorySnapshot): void {
  update((state) => {
    let index = -1;
    for (let i = state.snapshots.length - 1; i >= 0; i--) {
      if (state.snapshots[i].messageId === messageId) {
        index = i;
        break;
      }
    }
    if (index < 0) return state;
    const snapshots = [...state.snapshots];
    snapshots[index] = fn(snapshots[index]);
    return { ...state, snapshots };
  });
}

export function fileHistoryRecordShellChange(update: UpdateFileHistory, messageId: string, change: ShellChange): void {
  patchSnapshot(update, messageId, (snap) => ({ ...snap, shellChanges: [...(snap.shellChanges ?? []), change] }));
}

/** Notes how the agent left `path` in turn `messageId`. Once contested in a turn, it stays so:
 *  a later write of the agent's own doesn't make the other session's part its own. */
export function fileHistoryRecordLeftAs(update: UpdateFileHistory, messageId: string, path: string, left: LeftAs): void {
  patchSnapshot(update, messageId, (snap) => {
    const prev = snap.leftAs?.[path];
    if (prev && "contested" in prev) return snap;
    return { ...snap, leftAs: { ...snap.leftAs, [path]: left } };
  });
}

const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** What a rewind to snapshot `fromIndex` does with a file the agent edited:
 *  - `legacy`: some turn since then predates `leftAs`, so restore it as before, unchecked;
 *  - `check`: restore it only if it still holds `expected`, what the agent last left it as;
 *  - `keep`: someone else wrote it while the agent did, leave it;
 *  - `untouched`: the agent hasn't changed it since then, so any difference is someone else's. */
export type EditRestorePlan = { kind: "legacy" } | { kind: "check"; expected: string } | { kind: "keep" } | { kind: "untouched" };

export function planEditRestore(snapshots: FileHistorySnapshot[], fromIndex: number, path: string): EditRestorePlan {
  const later = snapshots.slice(Math.max(0, fromIndex));
  if (later.some((s) => !s.leftAs)) return { kind: "legacy" };
  const key = normPath(path);
  let expected: string | undefined;
  for (const snap of later) {
    for (const [p, left] of Object.entries(snap.leftAs!)) {
      if (normPath(p) !== key) continue;
      if ("contested" in left) return { kind: "keep" };
      expected = left.hash;
    }
  }
  return expected === undefined ? { kind: "untouched" } : { kind: "check", expected };
}

export interface ShellRestoreItem {
  file: string;
  before: string;
  after: string;
  /** Someone else may have written it while one of the commands ran (`ShellChange.contested`). */
  contested?: boolean;
}

export function planShellRestore(
  snapshots: FileHistorySnapshot[],
  fromIndex: number,
  trackedFiles: Iterable<string>,
  workspace: string,
): ShellRestoreItem[] {
  const tracked = new Set(Array.from(trackedFiles, normPath));
  const root = normPath(workspace).replace(/\/+$/, "");
  const items = new Map<string, ShellRestoreItem>();
  for (const snap of snapshots.slice(Math.max(0, fromIndex))) {
    for (const change of snap.shellChanges ?? []) {
      for (const file of change.files) {
        if (tracked.has(`${root}/${normPath(file)}`)) continue;
        const prev = items.get(file);
        const contested = prev?.contested || change.contested?.includes(file);
        items.set(file, { file, before: prev?.before ?? change.before, after: change.after, ...(contested ? { contested: true } : {}) });
      }
    }
  }
  return [...items.values()];
}

function groupBy<K>(items: ShellRestoreItem[], key: (i: ShellRestoreItem) => K): Map<K, ShellRestoreItem[]> {
  const out = new Map<K, ShellRestoreItem[]>();
  for (const item of items) {
    const k = key(item);
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
}

/** Splits a rewind's shell changes into the files it puts back and those it leaves as they are:
 *  ones someone else may have written while a command ran, and ones changed since the command
 *  left them, so the user's or another session's work is kept. When the current state can't be
 *  read, nothing is put back; when it can't be compared with what a command left, that command's
 *  files are kept. */
export async function sortShellRestore(
  workspace: string,
  items: ShellRestoreItem[],
  snapshot: ShadowSnapshot = shadowSnapshot,
  diff: ShadowDiff = shadowDiff,
): Promise<{ restore: ShellRestoreItem[]; kept: ShellRestoreItem[] }> {
  const restore: ShellRestoreItem[] = [];
  const kept: ShellRestoreItem[] = [];
  if (!items.length) return { restore, kept };
  const current = await snapshot(workspace);
  if (!current) return { restore, kept };
  for (const [after, group] of groupBy(items, (i) => i.after)) {
    const since = after === current ? [] : await diff(workspace, after, current);
    if (!since) {
      kept.push(...group);
      continue;
    }
    const changedSince = new Set(since);
    for (const item of group) (item.contested || changedSince.has(item.file) ? kept : restore).push(item);
  }
  return { restore, kept };
}

type ShadowRestore = (tree: string, files: string[]) => Promise<number>;

const shadowRestore = (workspace: string): ShadowRestore => (tree, files) =>
  invoke<number>("agent_shadow_restore", { workspace, tree, files });

export async function restoreShellChanges(
  workspace: string,
  items: ShellRestoreItem[],
  snapshot: ShadowSnapshot = shadowSnapshot,
  diff: ShadowDiff = shadowDiff,
  restore: ShadowRestore = shadowRestore(workspace),
): Promise<number> {
  return (await restoreShell(workspace, items, snapshot, diff, restore)).restored;
}

async function restoreShell(
  workspace: string,
  items: ShellRestoreItem[],
  snapshot: ShadowSnapshot = shadowSnapshot,
  diff: ShadowDiff = shadowDiff,
  restore: ShadowRestore = shadowRestore(workspace),
): Promise<{ restored: number; kept: ShellRestoreItem[]; failed: string[] }> {
  const sorted = await sortShellRestore(workspace, items, snapshot, diff);
  let restored = 0;
  const failed: string[] = [];
  for (const [before, group] of groupBy(sorted.restore, (i) => i.before)) {
    const files = group.map((i) => i.file);
    try {
      restored += await restore(before, files);
    } catch {
      // The backend restores nothing of a snapshot it can't read.
      failed.push(...files);
    }
  }
  return { restored, kept: sorted.kept, failed };
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[];
  trackedFiles: Set<string>;
  snapshotSequence: number;
}

const MAX_SNAPSHOTS = 100;

export function emptyFileHistoryState(): FileHistoryState {
  return { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 };
}

export interface SerializedFileHistory {
  snapshots: FileHistorySnapshot[];
  trackedFiles: string[];
  snapshotSequence: number;
}

export function serializeFileHistory(state: FileHistoryState): SerializedFileHistory {
  return {
    snapshots: state.snapshots,
    trackedFiles: Array.from(state.trackedFiles),
    snapshotSequence: state.snapshotSequence,
  };
}

export function deserializeFileHistory(data?: SerializedFileHistory | null): FileHistoryState {
  if (!data) return emptyFileHistoryState();
  return {
    snapshots: data.snapshots ?? [],
    trackedFiles: new Set(data.trackedFiles ?? []),
    snapshotSequence: data.snapshotSequence ?? 0,
  };
}

export type UpdateFileHistory = (updater: (prev: FileHistoryState) => FileHistoryState) => void;

async function createBackup(
  workspace: string,
  sessionId: string,
  path: string,
  version: number,
): Promise<FileHistoryBackup> {
  const res = await invoke<{ backupFileName: BackupFileName }>("agent_fh_backup", {
    workspace,
    sessionId,
    path,
    version,
  });
  return { backupFileName: res.backupFileName, version };
}

async function originChanged(
  workspace: string,
  sessionId: string,
  path: string,
  backupFileName: BackupFileName,
): Promise<boolean> {
  return await invoke<boolean>("agent_fh_origin_changed", {
    workspace,
    sessionId,
    path,
    backupFileName,
  });
}

export async function fileHistoryTrackEdit(
  update: UpdateFileHistory,
  workspace: string,
  sessionId: string,
  filePath: string,
): Promise<void> {
  let captured: FileHistoryState | undefined;
  update((s) => {
    captured = s;
    return s;
  });
  const mostRecent = captured?.snapshots.at(-1);
  if (!mostRecent) return;
  if (mostRecent.trackedFileBackups[filePath]) return;

  let backup: FileHistoryBackup;
  try {
    backup = await createBackup(workspace, sessionId, filePath, 1);
  } catch {
    return;
  }

  update((state) => {
    const snap = state.snapshots.at(-1);
    if (!snap || snap.trackedFileBackups[filePath]) return state;
    const updatedSnap: FileHistorySnapshot = {
      ...snap,
      trackedFileBackups: { ...snap.trackedFileBackups, [filePath]: backup },
    };
    const snapshots = state.snapshots.slice();
    snapshots[snapshots.length - 1] = updatedSnap;
    const trackedFiles = state.trackedFiles.has(filePath)
      ? state.trackedFiles
      : new Set(state.trackedFiles).add(filePath);
    return { ...state, snapshots, trackedFiles };
  });
}

export async function fileHistoryMakeSnapshot(
  update: UpdateFileHistory,
  workspace: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  let captured: FileHistoryState | undefined;
  update((s) => {
    captured = s;
    return s;
  });
  if (!captured) return;

  const trackedFileBackups: Record<string, FileHistoryBackup> = {};
  const mostRecent = captured.snapshots.at(-1);
  if (mostRecent) {
    await Promise.all(
      Array.from(captured.trackedFiles, async (path) => {
        try {
          const latest = mostRecent.trackedFileBackups[path];
          const nextVersion = latest ? latest.version + 1 : 1;
          if (
            latest &&
            latest.backupFileName !== null &&
            !(await originChanged(workspace, sessionId, path, latest.backupFileName))
          ) {
            trackedFileBackups[path] = latest;
            return;
          }
          trackedFileBackups[path] = await createBackup(workspace, sessionId, path, nextVersion);
        } catch {
          // best-effort: skip this file
        }
      }),
    );
  }

  update((state) => {
    const last = state.snapshots.at(-1);
    if (last) {
      for (const path of state.trackedFiles) {
        if (path in trackedFileBackups) continue;
        const inherited = last.trackedFileBackups[path];
        if (inherited) trackedFileBackups[path] = inherited;
      }
    }
    const newSnapshot: FileHistorySnapshot = {
      messageId,
      trackedFileBackups,
      timestamp: 0, // Date.now() is unused for ordering; snapshots are append-only
      leftAs: {},
    };
    const all = [...state.snapshots, newSnapshot];
    return {
      ...state,
      snapshots: all.length > MAX_SNAPSHOTS ? all.slice(-MAX_SNAPSHOTS) : all,
      snapshotSequence: state.snapshotSequence + 1,
    };
  });
}

function firstVersionBackup(state: FileHistoryState, path: string): BackupFileName | undefined {
  for (const snap of state.snapshots) {
    const backup = snap.trackedFileBackups[path];
    if (backup !== undefined && backup.version === 1) return backup.backupFileName;
  }
  return undefined;
}

export function fileHistoryCanRestore(state: FileHistoryState, messageId: string): boolean {
  return state.snapshots.some((s) => s.messageId === messageId);
}

function findSnapshot(state: FileHistoryState, messageId: string): number {
  for (let i = state.snapshots.length - 1; i >= 0; i--) {
    if (state.snapshots[i].messageId === messageId) return i;
  }
  return -1;
}

/** The backup a file goes back to when rewinding to `target`; undefined when it can't be restored. */
function restoreBackupFor(state: FileHistoryState, target: FileHistorySnapshot, path: string): BackupFileName | undefined {
  const targetBackup = target.trackedFileBackups[path];
  return targetBackup ? targetBackup.backupFileName : firstVersionBackup(state, path);
}

export interface RewindPreview {
  files: number;
  added: number;
  removed: number;
  /** The files that would be restored, relative to the workspace, sorted. */
  paths: string[];
  /** Files the agent changed (with its tools or a command) that the rewind leaves as they are,
   *  because someone else wrote them at the same time or since: relative, sorted. */
  kept: string[];
}

/** How the preview reads the shell side: the shadow trees, a file in one of them (null when the
 *  tree doesn't have it, undefined when it couldn't be read) and a file as it is on disk now
 *  (null when it doesn't exist). */
export interface ShellPreviewDeps {
  snapshot: ShadowSnapshot;
  diff: ShadowDiff;
  readAt: (workspace: string, tree: string, file: string) => Promise<string | null | undefined>;
  readNow: (path: string) => Promise<string | null>;
}

const readText = (path: string) => invoke<string | null>("agent_read_text", { path }).catch(() => null);

const defaultShellPreview: ShellPreviewDeps = {
  snapshot: shadowSnapshot,
  diff: shadowDiff,
  readAt: (workspace, tree, file) =>
    invoke<string | null>("agent_shadow_read", { workspace, tree, file }).catch(() => undefined),
  readNow: readText,
};

const unixText = (s: string) => s.replace(/\r\n/g, "\n");

function relativeTo(workspace: string, path: string): string {
  const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = path.replace(/\\/g, "/");
  return p.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? p.slice(root.length + 1) : p;
}

/** What rewinding the code to `messageId` would change: the files that differ now and their
 *  lines, both those the agent edited and those its shell commands changed. */
export async function fileHistoryRewindPreview(
  state: FileHistoryState,
  workspace: string,
  sessionId: string,
  messageId: string,
  shell: ShellPreviewDeps = defaultShellPreview,
): Promise<RewindPreview> {
  const preview: RewindPreview = { files: 0, added: 0, removed: 0, paths: [], kept: [] };
  const index = findSnapshot(state, messageId);
  if (index < 0) return preview;
  const target = state.snapshots[index];
  const count = (path: string, now: string | null, then: string | null) => {
    preview.files++;
    preview.paths.push(relativeTo(workspace, path));
    if (then === null) return;
    for (const change of diffLines(unixText(now ?? ""), unixText(then))) {
      if (change.added) preview.added += change.count ?? 0;
      else if (change.removed) preview.removed += change.count ?? 0;
    }
  };

  const keptEdits: string[] = [];
  const edited = Array.from(state.trackedFiles, async (path) => {
    const backupFileName = restoreBackupFor(state, target, path);
    if (backupFileName === undefined) return;
    try {
      const differs = await invoke<boolean>("agent_fh_origin_changed", { workspace, sessionId, path, backupFileName });
      if (!differs) return;
      if (!(await restoresEdit(state.snapshots, index, path))) return void keptEdits.push(relativeTo(workspace, path));
      const [now, then] = await Promise.all([
        readText(path),
        backupFileName === null
          ? Promise.resolve("")
          : invoke<string | null>("agent_fh_read_backup", { workspace, sessionId, backupFileName }).catch(() => null),
      ]);
      count(path, now, then);
    } catch {
      // best-effort per file
    }
  });

  // Files a command changed and the edit tools didn't (planShellRestore leaves those to the
  // backups above), kept only when the rewind would really put them back.
  const shellFiles = (async () => {
    const plan = planShellRestore(state.snapshots, index, state.trackedFiles, workspace);
    const { restore, kept } = await sortShellRestore(workspace, plan, shell.snapshot, shell.diff);
    const root = workspace.replace(/[\\/]+$/, "");
    const read = (item: ShellRestoreItem) =>
      Promise.all([shell.readNow(`${root}/${item.file}`), shell.readAt(workspace, item.before, item.file)]);
    const same = (now: string | null, then: string | null) =>
      now === then || (now !== null && then !== null && unixText(now) === unixText(then));
    await Promise.all([
      ...restore.map(async (item) => {
        try {
          const [now, then] = await read(item);
          // Unreadable: it will still be restored, so count it, without lines.
          if (then === undefined) return count(item.file, now, null);
          // Already back as it was (a later command undid it): nothing to restore.
          if (same(now, then)) return;
          count(item.file, now, then ?? "");
        } catch {
          // best-effort per file
        }
      }),
      ...kept.map(async (item) => {
        try {
          const [now, then] = await read(item);
          // Left alone, but the same as before the commands anyway: nothing is lost.
          if (then !== undefined && same(now, then)) return;
        } catch {
          // Unreadable: say it is kept all the same.
        }
        preview.kept.push(item.file);
      }),
    ]);
  })();

  await Promise.all([...edited, shellFiles]);
  preview.paths.sort((a, b) => a.localeCompare(b));
  // One list for both: a file edited with the tools and by a command shows once.
  preview.kept = [...new Set([...preview.kept, ...keptEdits])].sort((a, b) => a.localeCompare(b));
  return preview;
}

/** Whether a rewind would put back a file the agent edited, now that it differs from its backup
 *  (see `planEditRestore`). */
async function restoresEdit(snapshots: FileHistorySnapshot[], fromIndex: number, path: string): Promise<boolean> {
  const plan = planEditRestore(snapshots, fromIndex, path);
  if (plan.kind === "legacy") return true;
  if (plan.kind !== "check") return false;
  return (await invoke<string>("agent_fh_hash", { path }).catch(() => "")) === plan.expected;
}

/** What `agent_fh_restore` did with a file. */
interface RestoreOutcome {
  restored: boolean;
  kept: boolean;
  hash: string;
}

export interface RewindResult {
  /** Files put back. */
  changed: number;
  /** Files left as they are because someone else changed them (relative, sorted), as in
   *  `RewindPreview.kept`. */
  kept: string[];
  /** Files that couldn't be put back (a backup or a snapshot that can't be read), relative and
   *  sorted; only present when there are some. */
  failed?: string[];
}

export async function fileHistoryRewind(
  update: UpdateFileHistory,
  workspace: string,
  sessionId: string,
  messageId: string,
): Promise<RewindResult> {
  let captured: FileHistoryState | undefined;
  update((s) => {
    captured = s;
    return s;
  });
  if (!captured) return { changed: 0, kept: [] };

  const targetIndex = findSnapshot(captured, messageId);
  if (targetIndex < 0) throw new Error("The selected snapshot was not found");

  // Restoring writes files: a command another session runs meanwhile mustn't take it for its own.
  fileActivity.open(sessionId, "rewind");
  try {
    return await rewindFiles(update, captured, targetIndex, workspace, sessionId);
  } finally {
    fileActivity.close(sessionId, "rewind");
  }
}

async function rewindFiles(
  update: UpdateFileHistory,
  state: FileHistoryState,
  targetIndex: number,
  workspace: string,
  sessionId: string,
): Promise<RewindResult> {
  const target = state.snapshots[targetIndex];
  const latest = state.snapshots[state.snapshots.length - 1];
  const shell = await restoreShell(workspace, planShellRestore(state.snapshots, targetIndex, state.trackedFiles, workspace));
  const kept = new Set(shell.kept.map((i) => i.file));
  const failed = new Set(shell.failed);
  // Left alone, but only worth saying when it differs from what the rewind would have put back.
  const keep = async (path: string, backupFileName: BackupFileName) => {
    if (await invoke<boolean>("agent_fh_origin_changed", { workspace, sessionId, path, backupFileName }).catch(() => false)) {
      kept.add(relativeTo(workspace, path));
    }
  };

  let changed = 0;
  await Promise.all(
    Array.from(state.trackedFiles, async (path) => {
      const backupFileName = restoreBackupFor(state, target, path);
      if (backupFileName === undefined) return;
      const plan = planEditRestore(state.snapshots, targetIndex, path);
      try {
        if (plan.kind === "keep" || plan.kind === "untouched") return await keep(path, backupFileName);
        const out = await invoke<RestoreOutcome>("agent_fh_restore", {
          workspace,
          sessionId,
          path,
          backupFileName,
          expectedHash: plan.kind === "check" ? plan.expected : null,
        });
        if (out.kept) return await keep(path, backupFileName);
        if (!out.restored) return;
        changed++;
        // The restored file is now this session's own doing: a rewind further back must
        // recognize it, not take it for someone else's change.
        if (plan.kind === "check" && latest) fileHistoryRecordLeftAs(update, latest.messageId, path, { hash: out.hash });
      } catch {
        // Best-effort per file: the others are still put back, and this one is reported.
        failed.add(relativeTo(workspace, path));
      }
    }),
  );
  const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { changed: changed + shell.restored, kept: sort(kept), ...(failed.size ? { failed: sort(failed) } : {}) };
}
