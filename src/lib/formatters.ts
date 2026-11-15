import { invoke } from "@/lib/ipc";
import { fileCommand, matchGlob, relativeTo, workspaceMatchesDetect } from "@/lib/diagnostics";
import { getMergedSettings } from "@/lib/settingsRuntime";

export interface FormatterRule {
  name: string;
  match: string;
  detect?: string;
  command: string;
}

export const BUILTIN_FORMATTERS: FormatterRule[] = [
  {
    name: "biome",
    match: "**/*.{js,jsx,ts,tsx,mjs,cjs,json,jsonc,css}",
    detect: "biome.json,biome.jsonc",
    command: "npx --no-install biome format --write $FILE",
  },
  {
    name: "prettier",
    match: "**/*.{js,jsx,ts,tsx,mjs,cjs,css,scss,less,json,md,mdx,html,vue,svelte,yaml,yml}",
    detect: ".prettierrc,.prettierrc.*,prettier.config.*",
    command: "npx --no-install prettier --write $FILE",
  },
  { name: "ruff", match: "**/*.py", detect: "ruff.toml,.ruff.toml", command: "ruff format $FILE" },
  { name: "black", match: "**/*.py", detect: "pyproject.toml", command: "black -q $FILE" },
  { name: "rustfmt", match: "**/*.rs", detect: "rustfmt.toml,.rustfmt.toml", command: "rustfmt $FILE_ABS" },
  { name: "gofmt", match: "**/*.go", detect: "go.mod", command: "gofmt -w $FILE" },
];

interface FormatConfig {
  enabled: boolean;
  rules: FormatterRule[];
  timeoutMs: number;
}

function readConfig(raw: unknown): FormatConfig {
  const r = (raw ?? {}) as { enabled?: unknown; rules?: unknown; timeoutMs?: unknown };
  const rules = Array.isArray(r.rules)
    ? (r.rules as Partial<FormatterRule>[]).filter((x): x is FormatterRule => !!x?.match && !!x?.command).map((x) => ({ ...x, name: x.name ?? x.command.split(/\s+/)[0] }))
    : [];
  return {
    enabled: r.enabled === true,
    rules: rules.length ? rules : BUILTIN_FORMATTERS,
    timeoutMs: typeof r.timeoutMs === "number" && r.timeoutMs > 0 ? r.timeoutMs : 20_000,
  };
}

const failing = new Set<string>();

export async function formatAfterEdit(workspace: string, absPath: string): Promise<string | null> {
  if (!workspace) return null;
  let config: FormatConfig;
  try {
    config = readConfig((await getMergedSettings()).format);
  } catch {
    return null;
  }
  if (!config.enabled) return null;
  const rel = relativeTo(workspace, absPath);
  if (rel === null) return null;
  for (const rule of config.rules) {
    if (!matchGlob(rule.match, rel)) continue;
    const key = `${workspace}::${rule.command}`;
    if (failing.has(key)) continue;
    if (rule.detect && !(await workspaceMatchesDetect(workspace, rule.detect))) continue;
    const { command, env } = fileCommand(rule.command, workspace, rel, absPath);
    try {
      const before = await invoke<number | null>("agent_file_mtime", { path: absPath });
      const res = await invoke<{ code: number; timed_out: boolean }>("agent_run", {
        command,
        cwd: workspace,
        timeoutMs: config.timeoutMs,
        env,
      });
      if (res.timed_out || res.code !== 0) {
        failing.add(key);
        continue;
      }
      const after = await invoke<number | null>("agent_file_mtime", { path: absPath });
      return before !== after ? rule.name : null;
    } catch {
      failing.add(key);
    }
  }
  return null;
}
