import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A stand-in for the Tauri commands plugin and skill installs use, backed by a temp folder and
 * the real git. `agent_run` (the shell) throws, so a test fails if an install reaches for it.
 */
export interface FakeBackend {
  home: string;
  calls: { cmd: string; args: Record<string, unknown> }[];
  /** Answers `agent_fetch_html` (raw.githubusercontent.com) for GitHub marketplaces. */
  fetch: (url: string) => string | undefined;
  /** Makes `https://github.com/<owner>/<repo>.git` clone the local repo at `dir`. */
  serveGithub: (repo: string, dir: string) => void;
  /** What `npm pack <name>` packs: a local package folder per name (no registry, no network). */
  npmRegistry: Map<string, string>;
  handle: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  cleanup: () => void;
}

const slash = (p: string) => p.replace(/\\/g, "/");

export function makeTempDir(tag: string): string {
  return slash(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `nyxs-${tag}-`))));
}

function gitEnv(rewrites: Map<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const pairs = [...rewrites].map(([from, to]) => [`url.${to}.insteadOf`, from]);
  pairs.push(["protocol.file.allow", "always"], ["init.defaultBranch", "main"]);
  env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

const rewrites = new Map<string, string>();

/** Runs git for test setup (making the "remote" repos). */
export function gitSetup(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv(rewrites), stdio: "pipe" }).trim();
}

/** A local repo with one commit per entry of `commits` (files written relative to the repo). */
export function makeRepo(dir: string, commits: Record<string, string>[]): string[] {
  fs.mkdirSync(dir, { recursive: true });
  gitSetup(dir, "init", "-q");
  const shas: string[] = [];
  for (const [i, files] of commits.entries()) {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    gitSetup(dir, "add", "-A");
    gitSetup(dir, "commit", "-q", "-m", `commit ${i}`);
    shas.push(gitSetup(dir, "rev-parse", "HEAD"));
  }
  return shas;
}

export function fileUrl(dir: string): string {
  return pathToFileURL(dir).href;
}

/** Splits a command line quoted the way `shellQuote` does off Windows ('…' with '\''). */
function splitShell(command: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      cur = (cur ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (c === "\\" && command[i + 1] === "'") {
      cur = (cur ?? "") + "'";
      i++;
    } else if (c === " ") {
      if (cur !== null) out.push(cur);
      cur = null;
    } else {
      cur = (cur ?? "") + c;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * The only shell commands installs may run: `npm pack <name>` (packing the folder registered in
 * `npmRegistry`) and `tar -xzf`. Anything else fails the test.
 */
function runNpmOrTar(backend: FakeBackend, command: string, cwd: string) {
  const argv = splitShell(command);
  const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, timed_out: false });
  const fail = (stderr: string) => ({ stdout: "", stderr, code: 1, timed_out: false });
  try {
    if (!cwd || !fs.existsSync(cwd)) return fail(`no such folder: ${cwd}`);
    if (argv[0] === "npm" && argv[1] === "pack") {
      const local = backend.npmRegistry.get(argv[2]);
      if (!local) return fail(`404 Not Found: ${argv[2]}`);
      const destAt = argv.indexOf("--pack-destination");
      const dest = destAt > 0 ? path.resolve(cwd, argv[destAt + 1]) : cwd;
      const json = argv.includes("--json") ? " --json" : "";
      return ok(execSync(`npm pack "${local}" --pack-destination "${dest}"${json}`, { cwd, encoding: "utf8", stdio: "pipe" }));
    }
    if (argv[0] === "tar" && argv[1] === "-xzf") {
      return ok(execFileSync("tar", argv.slice(1), { cwd, encoding: "utf8", stdio: "pipe" }));
    }
  } catch (e) {
    return fail((e as { stderr?: string; message: string }).stderr || (e as Error).message);
  }
  throw new Error(`an install used the shell: ${command}`);
}

export function createFakeBackend(): FakeBackend {
  const home = makeTempDir("home");
  const managed = [".nyxs/plugins/", ".nyxs/skills/", ".nyxs/skill-install-cache/"].map((r) => `${home}/${r}`);
  const assertManaged = (p: string) => {
    if (!managed.some((r) => slash(p).startsWith(r))) throw new Error(`not a managed folder: ${p}`);
  };
  const backend: FakeBackend = {
    home,
    calls: [],
    fetch: () => undefined,
    serveGithub: (repo, dir) => rewrites.set(`https://github.com/${repo}.git`, fileUrl(dir)),
    npmRegistry: new Map(),
    async handle(cmd, args = {}) {
      backend.calls.push({ cmd, args });
      const p = String(args.path ?? "");
      switch (cmd) {
        case "agent_git": {
          const cwd = (args.cwd as string) || undefined;
          try {
            const stdout = execFileSync("git", args.args as string[], {
              cwd,
              encoding: "utf8",
              env: gitEnv(rewrites),
              stdio: ["ignore", "pipe", "pipe"],
            });
            return { stdout, stderr: "", code: 0, timed_out: false };
          } catch (e) {
            const err = e as { stdout?: string; stderr?: string; status?: number; message: string };
            return { stdout: err.stdout ?? "", stderr: err.stderr || err.message, code: err.status ?? 1, timed_out: false };
          }
        }
        case "agent_path_exists":
          return fs.existsSync(p);
        case "nyxs_read_text":
          return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
        case "agent_write_file":
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, String(args.content));
          return "OK";
        case "agent_allow_ui_path":
          return null;
        case "agent_list_dir":
          // Same shape as the real command: folders end in "/", files carry their size.
          if (!fs.existsSync(p)) throw new Error(`Couldn't list ${p}`);
          return fs
            .readdirSync(p, { withFileTypes: true })
            .map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name}  (${fs.statSync(path.join(p, e.name)).size} B)`));
        case "agent_fetch_html": {
          const body = backend.fetch(String(args.url));
          if (body === undefined) throw new Error(`HTTP 404 fetching ${String(args.url)}`);
          return body;
        }
        case "nyxs_copy_managed_dir": {
          const src = String(args.src);
          const dst = String(args.dst);
          assertManaged(dst);
          fs.rmSync(dst, { recursive: true, force: true });
          fs.cpSync(src, dst, { recursive: true, filter: (s) => path.basename(s) !== ".git" });
          return "OK";
        }
        case "nyxs_remove_managed_dir":
          assertManaged(p);
          fs.rmSync(p, { recursive: true, force: true });
          return "OK";
        case "agent_run":
          return runNpmOrTar(backend, String(args.command), String(args.cwd ?? ""));
        default:
          throw new Error(`unexpected command ${cmd}`);
      }
    },
    cleanup() {
      rewrites.clear();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
  return backend;
}
