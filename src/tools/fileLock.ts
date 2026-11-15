/**
 * One queue per file for the agent's writes (Edit, MultiEdit, Write, apply_patch). The tools of
 * a step run in parallel, and each one checks the file is still the version the agent read, then
 * reads, changes and writes it back: two at once on the same file had the second one either undo
 * the first or be refused as "changed on disk". Queued, the second starts once the first has
 * written and noted the file's new version, so both land. Writes to different files don't wait.
 * The backend also locks each file from reading to writing (`edit_lock` in text_io.rs), which
 * covers other sessions of the app.
 */
const tails = new Map<string, Promise<unknown>>();

/** The same file however the path is written: `\` as `/`, `.` and `..` resolved, and
 *  case-insensitive for Windows paths (a drive letter or a share). A remote path keeps its case. */
export function fileLockKey(path: string): string {
  const remote = /^[a-z][a-z0-9+.-]*:\/\//i.exec(path);
  if (remote && !/^file:/i.test(path)) return path;
  const slashed = path.replace(/\\/g, "/");
  const unc = slashed.startsWith("//");
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(part);
  }
  const joined = (unc ? "//" : slashed.startsWith("/") ? "/" : "") + parts.join("/");
  return unc || /^[a-z]:/i.test(joined) ? joined.toLowerCase() : joined;
}

/** Runs `fn` once every earlier write to the same file is over. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = fileLockKey(path);
  const run = (tails.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
