import { isRemotePath, resolveRemotePath } from "@/lib/remote";

export function normalizeWin(p: string): string {
  let s = p.replace(/\//g, "\\");
  let prefix = "";
  if (/^\\\\/.test(s)) {
    prefix = "\\\\";
    s = s.slice(2);
  } else {
    const m = /^([a-zA-Z]:)\\?/.exec(s);
    if (m) {
      prefix = `${m[1]}\\`;
      s = s.slice(m[0].length);
    }
  }
  const out: string[] = [];
  for (const seg of s.split("\\")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return prefix + out.join("\\");
}

/** A local macOS/Linux path: rooted at `/`, and not a `//server/share` UNC path. */
function isPosixPath(p: string): boolean {
  return p.startsWith("/") && !p.startsWith("//");
}

/** Collapses `.` and `..` in a path, in its own style: POSIX paths keep their root and `/` (a
 *  backslash is a valid character in their names), Windows and UNC ones go through normalizeWin. */
export function normalizePath(p: string): string {
  if (!isPosixPath(p)) return normalizeWin(p);
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** `rel` inside `base`, with the separator `base` already uses: `\` for a Windows path written
 *  with backslashes, `/` for POSIX, `ssh://` and Windows paths written with `/`. */
export function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}

export function isInside(child: string, parent: string): boolean {
  // POSIX file systems are case-sensitive; Windows ones aren't.
  if (isPosixPath(parent)) {
    const par = parent.replace(/\/+$/, "");
    // The root holds every POSIX path.
    if (!par) return isPosixPath(child);
    return child === par || child.startsWith(`${par}/`);
  }
  const c = child.toLowerCase();
  const par = parent.toLowerCase().replace(/\\+$/, "");
  return c === par || c.startsWith(`${par}\\`);
}

export interface AgentPathScope {
  id: string;
  extraRoots: string[];
}

export function normalizeRoots(roots: string[]): string[] {
  return roots
    .map((r) => (isRemotePath(r) ? r.replace(/\/+$/, "") : normalizePath(r.replace(/[\\/]+$/, ""))))
    .filter(Boolean);
}

export function resolvePath(p: string, workspace: string, extraRoots: string[] = []): string {
  if (isRemotePath(workspace)) return resolveRemotePath(p, workspace, extraRoots);
  const base = normalizePath(workspace.replace(/[\\/]+$/, ""));
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
  const sep = isPosixPath(base) ? "/" : "\\";
  const raw = isAbsolute ? p : `${base}${sep}${p.replace(/^[\\/]+/, "")}`;
  const resolved = normalizePath(raw);
  const allowed = isInside(resolved, base) || extraRoots.some((r) => isInside(resolved, r));
  if (!allowed) {
    throw new Error(
      `Acceso denegado: "${p}" está fuera de la carpeta del proyecto (${base}) ` +
        `y de las carpetas permitidas (skills globales del usuario). ` +
        `Solo puedes leer o escribir dentro del proyecto actual o de las skills globales.`,
    );
  }
  return resolved;
}
