import { invoke } from "@/lib/ipc";
import { isRemotePath } from "@/lib/remote";
import { getMergedSnapshot } from "./settingsRuntime";
import { DEFAULT_SETTINGS } from "./configSchema";
import { isDependencyResolutionNoise, isJsxEnvironmentNoise } from "./diagnostics";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: number;
  message: string;
  source?: string | null;
  code?: string | null;
}

export interface LspBinaryStatus {
  language: string;
  binary: string | null;
  installed: boolean;
  source: string;
  expectedNames: string[];
  provisionable: boolean;
}

export interface LspServerStatus {
  language: string;
  workspace: string;
  state: "starting" | "ready" | "crashed";
  binary: string;
  error?: string | null;
}

export interface LspConfig {
  enabled: boolean;
  autoInstall: boolean;
  diagnosticsWaitMs: number;
}

export function lspConfig(): LspConfig {
  const snap = (getMergedSnapshot() as { lsp?: Partial<LspConfig> }).lsp ?? {};
  return { ...DEFAULT_SETTINGS.lsp, ...snap } as LspConfig;
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  pyi: "python",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  yaml: "yaml",
  yml: "yaml",
  sh: "bash",
  bash: "bash",
};

const LANGUAGE_ID: Record<string, string> = {
  typescript: "typescript",
  javascript: "javascript",
  rust: "rust",
  python: "python",
  json: "json",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  yaml: "yaml",
  bash: "shellscript",
};

const EXT_TO_LANGUAGE_ID: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
};

function lspLanguageId(path: string, language: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (ext && EXT_TO_LANGUAGE_ID[ext]) || LANGUAGE_ID[language] || language;
}

export function extToLanguage(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  if (!m) return null;
  return EXT_TO_LANGUAGE[m[1].toLowerCase()] ?? null;
}

export function isLspSupported(path: string): boolean {
  return extToLanguage(path) !== null;
}

export function lspProvision(language: string): Promise<LspBinaryStatus> {
  return invoke<LspBinaryStatus>("lsp_provision", { language });
}

export function lspEnsureServer(workspace: string, language: string): Promise<LspServerStatus> {
  return invoke<LspServerStatus>("lsp_ensure_server", { workspace, language });
}

export function lspDisposeWorkspace(workspace: string): Promise<number> {
  return invoke<number>("lsp_dispose_workspace", { workspace });
}

export function lspDidOpen(
  workspace: string,
  language: string,
  uri: string,
  languageId: string,
  version: number,
  text: string,
  saved = false,
): Promise<void> {
  return invoke("lsp_did_open", { workspace, language, uri, languageId, version, text, saved });
}

export function lspDidChange(
  workspace: string,
  language: string,
  uri: string,
  languageId: string,
  text: string,
  saved = false,
): Promise<void> {
  return invoke("lsp_did_change", { workspace, language, uri, languageId, text, saved });
}

/** With `uri`, only that file's diagnostics published after its last change, or `{}` when they
 *  didn't come in time. Without it, everything stored once any file's are published. */
export function lspDiagnosticsWait(
  workspace: string,
  language: string,
  timeoutMs: number,
  uri?: string,
): Promise<Record<string, LspDiagnostic[]>> {
  return invoke<Record<string, LspDiagnostic[]>>("lsp_diagnostics_wait", {
    workspace,
    language,
    timeoutMs,
    uri: uri ?? null,
  });
}

export function lspHover(
  workspace: string,
  language: string,
  uri: string,
  line: number,
  character: number,
): Promise<unknown> {
  return invoke("lsp_hover", { workspace, language, uri, line, character });
}

export function lspDefinition(
  workspace: string,
  language: string,
  uri: string,
  line: number,
  character: number,
): Promise<unknown> {
  return invoke("lsp_definition", { workspace, language, uri, line, character });
}

export function lspReferences(
  workspace: string,
  language: string,
  uri: string,
  line: number,
  character: number,
  includeDeclaration: boolean,
): Promise<unknown> {
  return invoke("lsp_references", {
    workspace,
    language,
    uri,
    line,
    character,
    includeDeclaration,
  });
}

export function lspDocumentSymbols(
  workspace: string,
  language: string,
  uri: string,
): Promise<unknown> {
  return invoke("lsp_document_symbols", { workspace, language, uri });
}

const NOT_INSTALLED_PREFIX = "LSP_NOT_INSTALLED:";

const docVersions = new Map<string, number>();

function readRaw(absPath: string): Promise<string> {
  return invoke<string>("nyxs_read_text", { path: absPath });
}

const depsFingerprint = new Map<string, string>();
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

async function depsFingerprintFor(workspace: string): Promise<string> {
  const ws = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts: string[] = [];
  try {
    const nm = await invoke<boolean>("path_is_dir", { path: `${ws}/node_modules` });
    parts.push(nm ? "nm1" : "nm0");
  } catch {
    parts.push("nm?");
  }
  for (const f of LOCKFILES) {
    try {
      const mt = await invoke<number | null>("agent_file_mtime", { path: `${ws}/${f}` });
      parts.push(`${f}:${mt ?? 0}`);
    } catch {
      parts.push(`${f}:?`);
    }
  }
  return parts.join("|");
}

async function restartIfDepsChanged(workspace: string): Promise<void> {
  const fp = await depsFingerprintFor(workspace);
  const prev = depsFingerprint.get(workspace);
  depsFingerprint.set(workspace, fp);
  if (prev !== undefined && prev !== fp) {
    try {
      await lspDisposeWorkspace(workspace);
    } catch {
      // Best-effort: si falla, el server viejo sigue (a lo sumo, stale como antes).
    }
  }
}

export async function ensureServerForFile(
  workspace: string,
  absPath: string,
): Promise<string | null> {
  const cfg = lspConfig();
  if (!cfg.enabled || !workspace) return null;
  const language = extToLanguage(absPath);
  if (!language) return null;

  if (language === "typescript" || language === "javascript") {
    await restartIfDepsChanged(workspace);
  }

  try {
    const status = await lspEnsureServer(workspace, language);
    return status.state === "ready" ? language : null;
  } catch (e) {
    // A missing server is installed the first time its language is used (lsp.autoInstall),
    // in the background: the edit that found it goes on with the fallback checks meanwhile.
    if (String(e).startsWith(NOT_INSTALLED_PREFIX) && cfg.autoInstall) installInBackground(language);
    return null;
  }
}

/** One spelling per folder: `/`, no trailing slash, case-insensitive for a Windows path. */
function folderKey(folder: string): string {
  const k = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(k) ? k.toLowerCase() : k;
}

// The folders whose servers are kept, by folderKey, with one spelling of each to close it by.
let foldersInUse = new Map<string, string>();

/**
 * The folders the app is using now: the open one, the open chat's, and every folder a turn is
 * running in. A folder that was in use and no longer is gets its servers closed: a session's
 * worktree or a background session's project would otherwise keep its servers until Nyxs
 * closes, and closing on a folder switch killed those of a turn still working there.
 */
export function setLspFoldersInUse(folders: Iterable<string | null | undefined>): void {
  const next = new Map<string, string>();
  for (const f of folders) if (f) next.set(folderKey(f), f);
  for (const [key, folder] of foldersInUse) {
    if (!next.has(key)) void lspDisposeWorkspace(folder).catch(() => undefined);
  }
  foldersInUse = next;
}

const installing = new Map<string, Promise<boolean>>();

function installInBackground(language: string): void {
  if (installing.has(language)) return;
  const run = provisionServer(language).finally(() => installing.delete(language));
  installing.set(language, run);
}

export async function provisionServer(language: string): Promise<boolean> {
  try {
    const status = await lspProvision(language);
    return status.installed;
  } catch {
    return false;
  }
}

/** Sends the file's text to its server. `saved`: it was just written to disk, so the server
 *  also hears `didSave` (rust-analyzer runs `cargo check` only then). */
export async function syncFile(
  workspace: string,
  language: string,
  absPath: string,
  saved = false,
): Promise<string | null> {
  try {
    const uri = pathToUri(absPath);
    const text = await readRaw(absPath);
    const languageId = lspLanguageId(absPath, language);
    const seen = docVersions.has(uri);
    if (seen) {
      await lspDidChange(workspace, language, uri, languageId, text, saved);
    } else {
      docVersions.set(uri, 1);
      await lspDidOpen(workspace, language, uri, languageId, 1, text, saved);
    }
    return uri;
  } catch {
    return null;
  }
}

export interface LspDiagnosticsResult {
  handled: boolean;
  block: string | null;
}

export async function lspDiagnosticsForFile(
  workspace: string,
  absPath: string,
  relPath: string,
  maxOutputChars = 4_000,
): Promise<LspDiagnosticsResult> {
  const miss: LspDiagnosticsResult = { handled: false, block: null };
  const language = await ensureServerForFile(workspace, absPath);
  if (!language) return miss;

  const uri = await syncFile(workspace, language, absPath, true);
  if (!uri) return miss;

  const waitMs = lspConfig().diagnosticsWaitMs;
  const map = await lspDiagnosticsWait(workspace, language, waitMs, uri);
  // Nothing published for the file since the edit: not "no errors", so the fallback runs.
  const diags = findForFile(map, absPath);
  if (diags === null) return miss;

  if (diags.length === 0) return { handled: true, block: null };

  const visible = diags.filter(
    (d) => !isDependencyResolutionNoise(d.message) && !isJsxEnvironmentNoise(d.message),
  );
  if (visible.length === 0) return { handled: true, block: null };

  const lines = visible
    .slice()
    .sort((a, b) => a.range.start.line - b.range.start.line)
    .map((d) => formatDiagnostic(relPath, d));
  let body = lines.join("\n");
  if (body.length > maxOutputChars) {
    body = body.slice(0, maxOutputChars) + "\n… (diagnostics truncated)";
  }

  const block = [
    `<diagnostics file="${relPath}" tool="lsp">`,
    "Diagnostics for the file you just edited. Fix only issues your edit caused; ignore pre-existing unrelated ones. Do NOT install packages, change dependency versions, or run builds to satisfy diagnostics — that is the user's call, not part of this edit.",
    "",
    body,
    "</diagnostics>",
  ].join("\n");
  return { handled: true, block };
}

function uriToComparablePath(uri: string): string {
  let rest = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // URI mal formado: comparar tal cual.
  }
  if (/^\/[a-zA-Z]:/.test(rest)) rest = rest.slice(1);
  return rest.replace(/\\/g, "/").toLowerCase();
}

export function pickForFile(
  map: Record<string, LspDiagnostic[]>,
  absPath: string,
): LspDiagnostic[] {
  return findForFile(map, absPath) ?? [];
}

/** The file's diagnostics in `map`, or null when it has no entry at all. */
function findForFile(map: Record<string, LspDiagnostic[]>, absPath: string): LspDiagnostic[] | null {
  const want = absPath.replace(/\\/g, "/").toLowerCase();
  for (const [uri, list] of Object.entries(map)) {
    if (uriToComparablePath(uri) === want) return list;
  }
  return null;
}

function severityLabel(sev: number): string {
  switch (sev) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "error";
  }
}

export function formatDiagnostic(relPath: string, d: LspDiagnostic): string {
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  const tag = [d.source, d.code].filter(Boolean).join(" ");
  const suffix = tag ? ` (${tag})` : "";
  return `${relPath}:${line}:${col} ${severityLabel(d.severity)} ${d.message}${suffix}`;
}

/** The name the backend's LSP commands take for a file: a `file://` URI, or a remote project's
 *  `ssh://` path as is, which Rust turns into the URI on the server's machine (to_server_uri).
 *  Wrapped in `file:///` it would pass through untranslated and name no file. */
export function pathToUri(path: string): string {
  if (isRemotePath(path)) return path;
  const normalized = path.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
    .join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}
