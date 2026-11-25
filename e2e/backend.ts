// In-memory stand-in for the Rust commands the E2E flows touch. It keeps just enough state
// (files, secrets, settings, sessions) for the UI to behave as it does against src-tauri; the
// Rust side itself is covered by its own `cargo test` suite.

// Windows-style: the test browser reports Windows, so the app builds Windows paths.
export const WORKSPACE = "C:/e2e/project";
export const HOME = "C:/e2e/home";

export interface E2ESeed {
  /** Absolute path → contents. */
  files: Record<string, string>;
  /** Keychain entries (`nyxs_secret_*`). */
  secrets: Record<string, string>;
  /** Makes the project a git repo on a feature branch with an open PR (see `fakeGit`). */
  repo?: FakeRepo;
  /** Claude Code is installed and signed in, and `claude` runs the fake turn below. */
  claudeCode?: boolean;
}

export interface FakeRepo {
  branch: string;
  prNumber: number;
  /** Local commits the remote branch doesn't have. */
  ahead: number;
  /** The remote moved: the next push is rejected until a pull. */
  remoteMoved?: boolean;
  /** What the branch changes: in its commits, and not committed yet. */
  changes?: { committed: FakeChange[]; uncommitted: FakeChange[] };
}

export interface FakeChange {
  path: string;
  added: number;
  removed: number;
}

export interface E2EState {
  seed: E2ESeed;
  files: Map<string, string>;
  secrets: Map<string, string>;
  settings: Map<string, string>;
  /** sessionId → JSONL transcript lines. */
  transcripts: Map<string, string[]>;
  metas: Map<string, string>;
  /** Session worktrees removed from Settings' cleanup. */
  removedWorktrees: Set<string>;
  /** Every command the page invoked, in order. */
  calls: { cmd: string; args: Record<string, unknown> }[];
  /** Commands with no stub (answered with null). */
  unknown: string[];
  repo: FakeRepo | null;
  /** File backups by name: the content, or null for a file that didn't exist yet. */
  backups: Map<string, string | null>;
  /** Project snapshots by id: relative path → content. */
  trees: Map<string, Map<string, string>>;
  /** The fake `claude` processes, by run id. */
  claudeRuns: Map<string, ClaudeRun>;
}

type Args = Record<string, unknown>;
type Handler = (args: Args, state: E2EState) => unknown;

const norm = (p: unknown) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

function dirEntries(state: E2EState, dir: string): string[] {
  const prefix = `${norm(dir)}/`;
  const names = new Set<string>();
  for (const path of state.files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
  }
  return [...names].sort();
}

function isDir(state: E2EState, path: string): boolean {
  const p = norm(path);
  if (p === WORKSPACE) return true;
  for (const f of state.files.keys()) if (f.startsWith(`${p}/`)) return true;
  return false;
}

function readFile(state: E2EState, path: unknown): string {
  const content = state.files.get(norm(path));
  if (content === undefined) throw `File not found: ${String(path)}`;
  return content;
}

const ok = { stdout: "", stderr: "", code: 0, timed_out: false };
const out = (stdout: string, code = 0, stderr = "") => ({ stdout, stderr, code, timed_out: false });

/** `git diff` of the fake repo against `base`: the merge-base ("base") sees the branch's
 *  commits and the uncommitted edits, HEAD only the uncommitted ones. */
function fakeDiff(repo: FakeRepo, args: string[]) {
  const changes = repo.changes ?? { committed: [], uncommitted: [] };
  const NL = String.fromCharCode(10);
  const files = new Map<string, { added: number; removed: number }>();
  for (const c of [...(args.includes("base") ? changes.committed : []), ...changes.uncommitted]) {
    const f = files.get(c.path) ?? { added: 0, removed: 0 };
    files.set(c.path, { added: f.added + c.added, removed: f.removed + c.removed });
  }
  if (args.includes("--quiet")) return out("", changes.uncommitted.length ? 1 : 0);
  if (args.includes("--numstat")) return out([...files].map(([p, f]) => `${f.added}\t${f.removed}\t${p}`).join(NL));
  const patch = [...files].flatMap(([p, f]) => [
    `diff --git a/${p} b/${p}`,
    `--- a/${p}`,
    `+++ b/${p}`,
    `@@ -1,${f.removed} +1,${f.added} @@`,
    ...Array.from({ length: f.removed }, (_, i) => `-old ${i + 1}`),
    ...Array.from({ length: f.added }, (_, i) => `+new ${i + 1}`),
  ]);
  return out(patch.join(NL));
}

/** Just enough git for the Git bar: a clean feature branch with commits ahead of its upstream. */
function fakeGit(repo: FakeRepo, raw: string[]) {
  const args = raw.filter((a) => a !== "--no-optional-locks");
  // `-c key=value` config overrides (core.quotepath=false on diffs) don't change the fake's answer.
  while (args[0] === "-c") args.splice(0, 2);
  const line = args.join(" ");
  if (line === "rev-parse --abbrev-ref HEAD") return out(repo.branch);
  if (line === "symbolic-ref --short refs/remotes/origin/HEAD") return out("origin/main");
  if (line === "rev-parse --abbrev-ref --symbolic-full-name @{u}") return out(`origin/${repo.branch}`);
  if (args[0] === "merge-base") return out("base");
  if (args[0] === "diff" && !args.includes("--no-index")) return fakeDiff(repo, args);
  if (line.startsWith("rev-list --count")) return out(String(repo.ahead + 1));
  if (line.startsWith("rev-list --left-right --count")) return out(`${repo.ahead} ${repo.remoteMoved ? 1 : 0}`);
  if (args[0] === "push") {
    if (repo.remoteMoved) {
      const stderr = [
        ` ! [rejected]        ${repo.branch} -> ${repo.branch} (fetch first)`,
        "error: failed to push some refs",
        "hint: Updates were rejected because the remote contains work that you do not have locally.",
      ].join(String.fromCharCode(10));
      return out("", 1, stderr);
    }
    repo.ahead = 0;
    return ok;
  }
  if (args[0] === "pull") {
    repo.remoteMoved = false;
    return ok;
  }
  return ok;
}

// ── File history and shell snapshots ─────────────────────────────────────────
// The edit tools back a file up before changing it (agent_fh_*), and a Bash command is framed by
// two snapshots of the project (agent_shadow_*): rewinding puts both back. Here a backup or a
// snapshot is a copy of the in-memory files; a snapshot's id comes from its content, so taking
// one of an unchanged project gives the same id, as a git tree would.

const inWorkspace = (p: string) => p.startsWith(`${WORKSPACE}/`);
const relPath = (p: string) => p.slice(WORKSPACE.length + 1);

function takeSnapshot(s: E2EState): string {
  const files = [...s.files].filter(([p]) => inWorkspace(p)).map(([p, c]) => [relPath(p), c] as const).sort(([a], [b]) => a.localeCompare(b));
  const key = JSON.stringify(files);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const id = `tree-${(hash >>> 0).toString(16)}`;
  s.trees.set(id, new Map(files));
  return id;
}

/** `echo TEXT > FILE` (or `>>`), relative to the project: enough for a command that changes a file. */
function fakeShell(s: E2EState, command: string) {
  const m = /^echo\s+(.*?)\s*(>>?)\s*(\S+)$/.exec(command.trim());
  if (!m) return ok;
  const [, text, op, file] = m;
  const path = norm(file.includes(":") || file.startsWith("/") ? file : `${WORKSPACE}/${file}`);
  const line = `${text.replace(/^["']|["']$/g, "")}\n`;
  s.files.set(path, op === ">>" ? (s.files.get(path) ?? "") + line : line);
  return ok;
}

// ── A fake `claude` process ──────────────────────────────────────────────────
// Claude Code runs as a CLI that speaks stream-json: the app starts it (claude_code_start, with
// a channel for its output), writes JSON lines to its stdin (claude_code_send) and reads JSON
// lines back. This one answers a user message with the stream a real turn sends: its session,
// text as it's written, a Write tool call it asks permission for, the tool's result, the reply
// and the result. The file is only written if the app allows the call.

export const CLAUDE_FILE = `${WORKSPACE}/claude.txt`;
const CLAUDE_SESSION = "cc-e2e-session";
type ClaudeChannel = { onmessage: (event: { kind: "stdout"; line: string } | { kind: "exit"; code: number | null }) => void };

const claudeLine = (run: ClaudeRun, msg: Record<string, unknown>) =>
  run.channel.onmessage({ kind: "stdout", line: JSON.stringify(msg) });

const streamText = (run: ClaudeRun, text: string) => {
  claudeLine(run, { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 1200 } } } });
  claudeLine(run, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  claudeLine(run, { type: "stream_event", event: { type: "content_block_stop" } });
  claudeLine(run, { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 12 } } });
  claudeLine(run, { type: "stream_event", event: { type: "message_stop" } });
};

async function claudeTurn(run: ClaudeRun, s: E2EState) {
  const input = { file_path: CLAUDE_FILE, content: "hecho por claude\n" };
  claudeLine(run, { type: "system", subtype: "init", session_id: CLAUDE_SESSION });
  streamText(run, "Creo el archivo.");
  claudeLine(run, {
    type: "assistant",
    uuid: "cc-msg-1",
    session_id: CLAUDE_SESSION,
    message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "Creo el archivo." }, { type: "tool_use", id: "toolu_1", name: "Write", input }] },
  });
  const answer = await new Promise<Record<string, unknown>>((resolve) => {
    run.pending.set("cc-req-1", resolve);
    claudeLine(run, { type: "control_request", request_id: "cc-req-1", request: { subtype: "can_use_tool", tool_name: "Write", input, tool_use_id: "toolu_1" } });
  });
  // The app's answer: { behavior: "allow" | "deny", updatedInput?, toolUseID }.
  const allowed = answer.behavior === "allow";
  if (allowed) s.files.set(CLAUDE_FILE, input.content);
  claudeLine(run, {
    type: "user",
    session_id: CLAUDE_SESSION,
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: !allowed, content: allowed ? `File created successfully at: ${CLAUDE_FILE}` : "The user denied this action." }] },
  });
  const reply = allowed ? "Listo, archivo creado." : "De acuerdo, no lo creo.";
  streamText(run, reply);
  claudeLine(run, { type: "assistant", uuid: "cc-msg-2", session_id: CLAUDE_SESSION, message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: reply }] } });
  claudeLine(run, { type: "result", subtype: "success", is_error: false, result: reply, session_id: CLAUDE_SESSION, usage: { input_tokens: 1200, output_tokens: 24 } });
}

interface ClaudeRun {
  channel: ClaudeChannel;
  /** Permission requests waiting for the app's answer, by request id. */
  pending: Map<string, (response: Record<string, unknown>) => void>;
}

const handlers: Record<string, Handler> = {
  // Account, keychain and settings.
  nyxs_secret_get: ({ account }, s) => s.secrets.get(String(account)) ?? null,
  nyxs_secret_set: ({ account, secret }, s) => void s.secrets.set(String(account), String(secret)),
  nyxs_secret_delete: ({ account }, s) => void s.secrets.delete(String(account)),
  nyxs_read_settings: ({ source, workspace }, s) => s.settings.get(`${source}:${workspace ?? ""}`) ?? "",
  nyxs_write_settings: ({ source, workspace, json }, s) =>
    void s.settings.set(`${source}:${workspace ?? ""}`, String(json)),
  nyxs_headless_args: () => null,
  nyxs_set_account: () => null,
  nyxs_adopt_account_data: () => null,
  agent_allow_ui_path: () => null,
  "plugin:path|resolve_directory": () => HOME,
  device_info: () => ({ os: "e2e", arch: "x64", hostname: "e2e", version: "0.0.0" }),
  keep_awake_get: () => false,
  worktree_supported: () => false,
  // The worktrees sessions name are measured as a fixed size each; a removed one is gone.
  session_worktrees_measure: ({ paths }, s) =>
    (paths as string[]).map((path) => ({
      path,
      exists: !s.removedWorktrees.has(path),
      bytes: 3 * 1024 ** 3,
      uncommitted: path.endsWith("-dirty") ? 2 : 0,
    })),
  session_worktree_remove: ({ path }, s) => void s.removedWorktrees.add(String(path)),
  agent_shell_info: () => "bash",
  default_browser_name: () => null,

  // Chats and per-project sessions.
  nyxs_load_chat_index: () => JSON.stringify({ version: 2, activeId: null, chats: [] }),
  nyxs_load_chats: () => "",
  nyxs_load_chat: () => "",
  nyxs_save_chat_index: () => null,
  nyxs_save_chat: () => null,
  nyxs_session_append: ({ sessionId, line }, s) => {
    const id = String(sessionId);
    s.transcripts.set(id, [...(s.transcripts.get(id) ?? []), String(line)]);
  },
  nyxs_session_write_transcript: ({ sessionId, content }, s) =>
    void s.transcripts.set(String(sessionId), String(content).split("\n").filter(Boolean)),
  nyxs_session_write_meta: ({ sessionId, json }, s) => void s.metas.set(String(sessionId), String(json)),
  nyxs_session_read: ({ sessionId }, s) => ({
    transcript: (s.transcripts.get(String(sessionId)) ?? []).join("\n"),
    meta: s.metas.get(String(sessionId)) ?? "",
  }),
  nyxs_session_read_meta: ({ sessionId }, s) => ({
    transcript: "",
    meta: s.metas.get(String(sessionId)) ?? "",
  }),
  nyxs_session_delete: ({ sessionId }, s) => {
    s.transcripts.delete(String(sessionId));
    s.metas.delete(String(sessionId));
  },
  nyxs_list_sessions: (_a, s) =>
    [...new Set([...s.metas.keys(), ...s.transcripts.keys()])].map((id) => ({
      id,
      meta: s.metas.get(id) ?? "",
      modifiedAt: Date.now(),
      messageCount: s.transcripts.get(id)?.length ?? 0,
      gitBranch: null,
    })),
  nyxs_search_sessions: () => [],

  // Files.
  path_is_dir: ({ path }, s) => isDir(s, String(path)),
  agent_path_exists: ({ path }, s) => s.files.has(norm(path)) || isDir(s, String(path)),
  agent_list_dir: ({ path }, s) => dirEntries(s, String(path)),
  agent_list_files: (_a, s) => [...s.files.keys()].filter((p) => p.startsWith(`${WORKSPACE}/`)),
  agent_glob: () => [],
  agent_grep: () => "",
  agent_file_mtime: ({ path }, s) => (s.files.has(norm(path)) ? 1 : null),
  agent_read_text: ({ path }, s) => s.files.get(norm(path)) ?? null,
  // A seeded text file (an ASCII STL, say) as the 3D view's bytes.
  agent_read_model: ({ path }, s) => btoa(readFile(s, path)),
  nyxs_read_text: ({ path }, s) => s.files.get(norm(path)) ?? "",
  agent_read_file_range: ({ path, offset, limit }, s) => {
    const lines = readFile(s, path).split("\n");
    const start = Number(offset ?? 0);
    const end = Math.min(lines.length, start + Number(limit ?? 2000));
    const text = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
      .join("\n");
    return { text, startLine: start + 1, endLine: end, totalLines: lines.length };
  },
  agent_write_file: ({ path, content }, s) => {
    s.files.set(norm(path), String(content));
    return `OK: wrote ${String(content).length} bytes to ${String(path)}`;
  },
  agent_edit_file: ({ path, oldString, newString, replaceAll }, s) => {
    const before = readFile(s, path);
    const old = String(oldString);
    if (!before.includes(old)) throw `old_string not found in ${String(path)}`;
    const after = replaceAll ? before.split(old).join(String(newString)) : before.replace(old, String(newString));
    s.files.set(norm(path), after);
    return `OK: edited ${String(path)}`;
  },
  agent_read_memory: () => "",
  agent_read_claude_memory: () => "",
  agent_list_skills: () => [],

  // History, git and processes: nothing to snapshot or run.
  agent_shadow_snapshot: (_a, s) => takeSnapshot(s),
  agent_shadow_changed: ({ from, to }, s) => {
    const a = s.trees.get(String(from)) ?? new Map<string, string>();
    const b = s.trees.get(String(to)) ?? new Map<string, string>();
    return [...new Set([...a.keys(), ...b.keys()])].filter((f) => a.get(f) !== b.get(f)).sort();
  },
  agent_shadow_read: ({ tree, file }, s) => s.trees.get(String(tree))?.get(String(file)) ?? null,
  agent_shadow_restore: ({ tree, files }, s) => {
    const saved = s.trees.get(String(tree));
    if (!saved) return 0;
    for (const f of files as string[]) {
      const content = saved.get(f);
      if (content === undefined) s.files.delete(`${WORKSPACE}/${f}`);
      else s.files.set(`${WORKSPACE}/${f}`, content);
    }
    return (files as string[]).length;
  },
  agent_fh_backup: ({ sessionId, path, version }, s) => {
    const content = s.files.get(norm(path));
    if (content === undefined) return { backupFileName: null };
    const name = `${String(sessionId)}@v${String(version)}@${norm(path).split("/").pop()}`;
    s.backups.set(name, content);
    return { backupFileName: name };
  },
  agent_fh_origin_changed: ({ path, backupFileName }, s) => {
    const now = s.files.get(norm(path));
    return backupFileName === null ? now !== undefined : now !== s.backups.get(String(backupFileName));
  },
  agent_fh_read_backup: ({ backupFileName }, s) => s.backups.get(String(backupFileName)) ?? null,
  agent_fh_restore: ({ path, backupFileName }, s) => {
    const before = s.files.get(norm(path));
    if (backupFileName === null) s.files.delete(norm(path));
    else s.files.set(norm(path), s.backups.get(String(backupFileName)) ?? "");
    return before !== s.files.get(norm(path));
  },
  agent_git: ({ args }, s) =>
    s.repo ? fakeGit(s.repo, (args as string[]) ?? []) : { ...ok, code: 128, stderr: "fatal: not a git repository" },
  agent_exec: ({ program, args }, s) => {
    const a = (args as string[]) ?? [];
    if (s.repo && program === "gh" && a[0] === "pr" && (a[1] === "view" || a[1] === "list")) {
      const pr = {
        state: "OPEN", isDraft: false, number: s.repo.prNumber, url: `https://github.com/acme/app/pull/${s.repo.prNumber}`,
        baseRefName: "main", headRefName: s.repo.branch, headRepositoryOwner: { login: "acme" },
        statusCheckRollup: [], headRefOid: "head",
      };
      // The Git bar looks a branch's PR up with `pr list --head`, Recents too.
      return out(JSON.stringify(a[1] === "list" ? [pr] : pr));
    }
    return ok;
  },
  agent_run: ({ command }, s) => fakeShell(s, String(command ?? "")),
  agent_bg_list: () => [],
  rag_collect_chunks: () => [],
  lsp_dispose_workspace: () => null,
  fs_watch_start: () => null,
  fs_watch_stop: () => null,
  claude_code_status: (_a, s) =>
    s.seed.claudeCode ? { installed: true, version: "2.1.400", loggedIn: true, path: "C:/e2e/bin/claude.exe" } : { installed: false },
  claude_code_start: ({ request, onEvent }, s) => {
    const runId = String((request as Record<string, unknown>).runId);
    s.claudeRuns.set(runId, { channel: onEvent as ClaudeChannel, pending: new Map() });
    return null;
  },
  claude_code_send: ({ runId, line }, s) => {
    const run = s.claudeRuns.get(String(runId));
    if (!run) throw "Claude Code is not running";
    const msg = JSON.parse(String(line)) as Record<string, unknown>;
    if (msg.type === "user") void claudeTurn(run, s);
    else if (msg.type === "control_response") {
      const response = (msg.response ?? {}) as Record<string, unknown>;
      run.pending.get(String(response.request_id))?.((response.response ?? {}) as Record<string, unknown>);
      run.pending.delete(String(response.request_id));
    } else if (msg.type === "control_request") {
      // initialize, interrupt…: accepted.
      queueMicrotask(() => claudeLine(run, { type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } }));
    }
    return null;
  },
  claude_code_close_input: ({ runId }, s) => {
    const run = s.claudeRuns.get(String(runId));
    s.claudeRuns.delete(String(runId));
    queueMicrotask(() => run?.channel.onmessage({ kind: "exit", code: 0 }));
    return null;
  },
  claude_code_kill: ({ runId }, s) => {
    s.claudeRuns.get(String(runId))?.channel.onmessage({ kind: "exit", code: null });
    s.claudeRuns.delete(String(runId));
    return true;
  },
  agent_cli_status: () => ({ installed: false }),
  claude_code_runs: () => [],
};

export function createBackend(seed: Partial<E2ESeed>) {
  const fullSeed: E2ESeed = { files: seed.files ?? {}, secrets: seed.secrets ?? {}, repo: seed.repo, claudeCode: seed.claudeCode };
  const state: E2EState = {
    seed: fullSeed,
    files: new Map(Object.entries(fullSeed.files).map(([p, c]) => [norm(p), c])),
    secrets: new Map(Object.entries(fullSeed.secrets)),
    settings: new Map(),
    transcripts: new Map(),
    metas: new Map(),
    calls: [],
    unknown: [],
    repo: fullSeed.repo ? { ...fullSeed.repo } : null,
    backups: new Map(),
    trees: new Map(),
    claudeRuns: new Map(),
    removedWorktrees: new Set(),
  };

  function handle(cmd: string, args: Args): unknown {
    state.calls.push({ cmd, args });
    const h = handlers[cmd];
    if (h) return h(args, state);
    if (!cmd.startsWith("plugin:") && !state.unknown.includes(cmd)) state.unknown.push(cmd);
    return null;
  }

  return { state, handle };
}
