import { desktopOs } from "@/lib/desktopOs";
import { invoke } from "@/lib/ipc";
import { isRemotePath } from "@/lib/remote";
import { getMergedSettings } from "@/lib/settingsRuntime";

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
}

export interface DiagnosticRule {
  match: string;
  command: string;
  detect?: string;
  scope?: "all" | "file";
}

interface DiagnosticsConfig {
  enabled: boolean;
  timeoutMs: number;
  maxOutputChars: number;
  rules: DiagnosticRule[];
  autoFix: boolean;
  autoFixMaxAttempts: number;
  showInUi: boolean;
}

const DEFAULT_RULES: DiagnosticRule[] = [
  {
    match: "**/*.{js,jsx,ts,tsx,cjs,mjs,cts,mts}",
    detect: ".eslintrc*,eslint.config.*",
    command: 'npx --no-install eslint "$FILE"',
  },
  {
    match: "**/*.{ts,tsx,cts,mts}",
    detect: "tsconfig.json",
    command: "npx --no-install tsc --noEmit --pretty false",
    scope: "file",
  },
  {
    match: "**/*.py",
    detect: "ruff.toml,.ruff.toml,pyproject.toml",
    command: 'ruff check "$FILE"',
  },
];

const DEFAULTS = {
  enabled: true,
  timeoutMs: 30_000,
  maxOutputChars: 4_000,
  autoFix: true,
  autoFixMaxAttempts: 3,
  showInUi: false,
};

const MISSING_TOOL_SIGNATURES = [
  "is not recognized", // PowerShell: 'x' is not recognized as a cmdlet…
  "command not found",
  "could not determine executable",
  "npm error could not determine",
  "no such file or directory",
  "cannot find module",
  "enoent",
];

const CHECKER_FAILURE_SIGNATURES = [
  "oops! something went wrong", // ESLint flat-config crash banner
  "failed to load config",
  "failed to load plugin",
  "failed to load parser",
  "failed to patch eslint",
  "couldn't find the config",
  "couldn't find a configuration file",
  "cannot read config file",
  "invalid eslint configuration",
  "a config object", // "A config object is using the 'extends' key…"
  "is not a function", // plugin/API version mismatch (e.g. context.getScope is not a function)
  "err_require_esm",
  "require() of es module",
  "unknown options", // CLI option drift between major versions
  "unknown option",
  "invalid option",
  "was not found", // 'plugin "react" was not found'
  "eslint couldn't determine the plugin",
  "error [err_", // generic Node error code in a stack trace
];

export function isDependencyResolutionNoise(message: string): boolean {
  const m = message.toLowerCase();
  const match =
    /cannot find module '([^']+)'/.exec(m) ||
    /could not find a declaration file for module '([^']+)'/.exec(m);
  if (!match) return false;
  const spec = match[1];
  return !/^(\.|\/|[a-z]:)/i.test(spec);
}

export function isJsxEnvironmentNoise(message: string): boolean {
  if (/\bTS(17004|6142|7026|2503|2874|2875|2876)\b/.test(message)) return true;
  const m = message.toLowerCase();
  return (
    m.includes("cannot use jsx unless the '--jsx' flag") ||
    (m.includes("jsx element implicitly has type 'any'") && m.includes("jsx.intrinsicelements")) ||
    m.includes("cannot find namespace 'jsx'") ||
    m.includes("react/jsx-runtime")
  );
}

function filterDependencyNoiseLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isDependencyResolutionNoise(line) && !isJsxEnvironmentNoise(line))
    .join("\n")
    .trim();
}

const detectCache = new Map<string, boolean>();
const missingToolCache = new Set<string>();
const brokenCheckerCache = new Set<string>();

export function clearDiagnosticsCache(): void {
  detectCache.clear();
  missingToolCache.clear();
  brokenCheckerCache.clear();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = glob
          .slice(i + 1, end)
          .split(",")
          .map((a) => escapeRegex(a))
          .join("|");
        re += `(?:${alts})`;
        i = end;
      }
    } else {
      re += escapeRegex(c);
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(pattern: string, relPath: string): boolean {
  const re = globToRegExp(pattern);
  if (re.test(relPath)) return true;
  if (!pattern.includes("/")) {
    const base = relPath.split("/").pop() ?? relPath;
    return re.test(base);
  }
  return false;
}

function readConfig(raw: unknown): DiagnosticsConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawRules = Array.isArray(cfg.rules) ? cfg.rules : null;
  const rules: DiagnosticRule[] = [];
  if (rawRules) {
    for (const r of rawRules) {
      if (r && typeof r === "object") {
        const rr = r as Record<string, unknown>;
        if (typeof rr.match === "string" && typeof rr.command === "string") {
          rules.push({
            match: rr.match,
            command: rr.command,
            detect: typeof rr.detect === "string" ? rr.detect : undefined,
            scope: rr.scope === "file" ? "file" : undefined,
          });
        }
      }
    }
  }
  return {
    enabled: cfg.enabled === undefined ? DEFAULTS.enabled : cfg.enabled !== false,
    timeoutMs: typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULTS.timeoutMs,
    maxOutputChars:
      typeof cfg.maxOutputChars === "number" && cfg.maxOutputChars > 0
        ? cfg.maxOutputChars
        : DEFAULTS.maxOutputChars,
    rules: rules.length > 0 ? rules : DEFAULT_RULES,
    autoFix: cfg.autoFix === undefined ? DEFAULTS.autoFix : cfg.autoFix !== false,
    autoFixMaxAttempts:
      typeof cfg.autoFixMaxAttempts === "number" && cfg.autoFixMaxAttempts > 0
        ? Math.floor(cfg.autoFixMaxAttempts)
        : DEFAULTS.autoFixMaxAttempts,
    showInUi: cfg.showInUi === true,
  };
}

export async function getDiagnosticsRuntime(): Promise<{
  autoFix: boolean;
  maxAttempts: number;
  showInUi: boolean;
}> {
  try {
    const merged = await getMergedSettings();
    const cfg = readConfig(merged.diagnostics);
    return {
      autoFix: cfg.enabled && cfg.autoFix,
      maxAttempts: cfg.autoFixMaxAttempts,
      showInUi: cfg.enabled && cfg.showInUi,
    };
  } catch {
    return {
      autoFix: DEFAULTS.enabled && DEFAULTS.autoFix,
      maxAttempts: DEFAULTS.autoFixMaxAttempts,
      showInUi: DEFAULTS.enabled && DEFAULTS.showInUi,
    };
  }
}

/** Whether `agent_run` runs a workspace's commands in PowerShell: on Windows, and on a remote
 *  Windows machine (`ssh://host/C:/…`); bash everywhere else. */
function runsPowerShell(workspace: string): boolean {
  if (isRemotePath(workspace)) return /^ssh:\/\/[^/]+\/[A-Za-z]:\//.test(workspace);
  return desktopOs() === "windows";
}

/** A rule's command with `$FILE` and `$FILE_ABS` turned into references to environment
 *  variables that hold those paths, and the variables to run it with. Written into the command
 *  line itself, a file named `a$(…).ts` would run that `…` in the shell. */
export function fileCommand(
  command: string,
  workspace: string,
  rel: string,
  abs: string,
): { command: string; env: Record<string, string> | undefined } {
  if (!command.includes("$FILE")) return { command, env: undefined };
  const ref = (name: string) => (runsPowerShell(workspace) ? `\${env:${name}}` : `\${${name}}`);
  const out = command
    // Inside single quotes a variable isn't expanded in either shell.
    .replace(/'(\$FILE(?:_ABS)?)'/g, (_, placeholder: string) => `"${placeholder}"`)
    .replace(/\$FILE_ABS/g, () => ref("NYXS_FILE_ABS"))
    .replace(/\$FILE/g, () => ref("NYXS_FILE"));
  return { command: out, env: { NYXS_FILE: rel, NYXS_FILE_ABS: abs.replace(/\\/g, "/") } };
}

export function relativeTo(workspace: string, abs: string): string | null {
  const ws = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = abs.replace(/\\/g, "/");
  if (!p.toLowerCase().startsWith(ws.toLowerCase() + "/")) return null;
  return p.slice(ws.length + 1);
}

function displayTool(command: string): string {
  const tokens = command.trim().split(/\s+/);
  for (const t of tokens) {
    if (t === "npx" || t.startsWith("-")) continue;
    return t;
  }
  return tokens[0] ?? command;
}

function scopeOutputToFile(output: string, rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes(rel) || line.includes(base))
    .join("\n")
    .trim();
}

export async function workspaceMatchesDetect(workspace: string, detect: string): Promise<boolean> {
  const key = `${workspace}::${detect}`;
  const cached = detectCache.get(key);
  if (cached !== undefined) return cached;

  let found = false;
  for (const pattern of detect.split(",").map((p) => p.trim()).filter(Boolean)) {
    try {
      const hits = await invoke<string[]>("agent_glob", { pattern, cwd: workspace });
      if (hits.length > 0) {
        found = true;
        break;
      }
    } catch {
      // Glob failure is non-fatal: just treat this pattern as no-match.
    }
  }
  detectCache.set(key, found);
  return found;
}

export async function runDiagnosticsForFile(
  workspace: string,
  absPath: string,
): Promise<string | null> {
  try {
    if (!workspace) return null;

    const merged = await getMergedSettings();
    const config = readConfig(merged.diagnostics);
    if (!config.enabled) return null;

    const rel = relativeTo(workspace, absPath);
    if (rel === null) return null;

    const candidates = config.rules.filter((r) => matchGlob(r.match, rel));
    if (candidates.length === 0) return null;

    let rule: DiagnosticRule | null = null;
    for (const c of candidates) {
      const key = `${workspace}::${c.command}`;
      if (missingToolCache.has(key) || brokenCheckerCache.has(key)) continue;
      if (c.detect && !(await workspaceMatchesDetect(workspace, c.detect))) continue;
      rule = c;
      break;
    }
    if (!rule) return null;

    const missKey = `${workspace}::${rule.command}`;

    const { command, env } = fileCommand(rule.command, workspace, rel, absPath);

    const res = await invoke<RunResult>("agent_run", {
      command,
      cwd: workspace,
      timeoutMs: config.timeoutMs,
      env,
    });

    if (res.timed_out) return null;

    const rawCombined = `${res.stdout}\n${res.stderr}`.trim();

    const lower = rawCombined.toLowerCase();
    const looksMissing = MISSING_TOOL_SIGNATURES.some((sig) => lower.includes(sig));
    if (looksMissing && res.code !== 0 && !res.stdout.trim()) {
      missingToolCache.add(missKey);
      return null;
    }

    if (res.code !== 0 && CHECKER_FAILURE_SIGNATURES.some((sig) => lower.includes(sig))) {
      brokenCheckerCache.add(missKey);
      return null;
    }

    const scoped = rule.scope === "file" ? scopeOutputToFile(rawCombined, rel) : rawCombined;
    const combined = filterDependencyNoiseLines(scoped);

    if (res.code === 0 && !combined) return null;
    if (!combined) return null;

    let body = combined;
    if (body.length > config.maxOutputChars) {
      body = body.slice(0, config.maxOutputChars) + "\n… (diagnostics truncated)";
    }

    const tool = displayTool(rule.command);
    return [
      `<diagnostics file="${rel}" tool="${tool}">`,
      "Diagnostics for the file you just edited. Fix only issues your edit caused; ignore pre-existing unrelated ones. Do NOT install packages, change dependency versions, or run builds to satisfy diagnostics — that is the user's call, not part of this edit.",
      "",
      body,
      "</diagnostics>",
    ].join("\n");
  } catch {
    return null;
  }
}
