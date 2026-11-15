import { shellSegments } from "./shellWords";

export type CommandRisk = "safe" | "dangerous" | "destructive";

export interface CommandRiskResult {
  risk: CommandRisk;
  reason?: string;
}

const DANGEROUS_BASES = new Set([
  "python", "python3", "node", "deno", "tsx", "ts-node", "ruby", "perl", "php", "lua", "rscript",
  "npx", "bunx", "pnpx", "bash", "sh", "zsh", "fish", "pwsh", "powershell", "cmd",
  "ssh", "scp", "telnet", "nc", "ncat", "eval", "exec", "source", ".", "sudo", "doas", "runas",
  "curl", "wget", "iwr", "invoke-webrequest", "invoke-expression", "iex",
  "start-process", "saps", "invoke-command", "icm",
  "git", "kubectl", "helm", "aws", "gcloud", "az", "docker", "rm", "del", "erase", "format",
]);

const DESTRUCTIVE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\b[^|;&\n]*\s-{1,2}[a-z-]*r/i, reason: "recursive delete (rm -r)" },
  { re: /\brm\b[^|;&\n]*--recursive/i, reason: "recursive delete (rm --recursive)" },
  { re: /\brm\b[^|;&\n]*\s-{1,2}[a-z-]*f[a-z-]*\s+[~*/]/i, reason: "forced delete of home/root/glob (rm -f ~ | / | *)" },
  { re: /\b(remove-item|ri|rmdir|rd)\b[^|;&\n]*-(recurse|force|fo|r|f)\b/i, reason: "recursive/forced delete (Remove-Item)" },
  { re: /\b(del|erase)\b[^|;&\n]*\/(s|q|f)\b/i, reason: "forced delete (del /s /q /f)" },
  { re: /\brmdir\b[^|;&\n]*\/s\b/i, reason: "recursive rmdir (/s)" },
  { re: /\b(shred|wipefs|sgdisk|blkdiscard)\b/i, reason: "secure-erase / wipe utility" },
  { re: /\btruncate\b[^|;&\n]*\s-s\s*0\b/i, reason: "truncate file to zero bytes" },
  // Only as the command itself (`format D:`, `mkfs.ext4 /dev/sdb1`), so the word inside another
  // command (`ffprobe -show_entries format=duration`, `git log --format=…`, `clang-format`)
  // isn't taken for wiping a disk.
  {
    re: /(^|[;&|\n(]|\b(sudo|doas|runas)\s+|\bcmd(\.exe)?\s+\/[ck]\s+)\s*(format(\.com|\.exe)?\s+[a-z]:|mkfs(\.\w+)?(\s|$))/im,
    reason: "filesystem format",
  },
  { re: /\b(format-volume|clear-disk|initialize-disk|clear-content)\b/i, reason: "disk/volume wipe" },
  { re: /\bdd\b[^|;&\n]*\b(if|of)=/i, reason: "raw disk write (dd)" },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: "write to raw disk device" },
  { re: /\bgit\s+reset\s+--hard/i, reason: "git reset --hard (discards changes)" },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, reason: "git clean -f (deletes untracked files)" },
  { re: /\bgit\s+push\b[^|;&\n]*(--force|\s-f\b)/i, reason: "git push --force (rewrites remote history)" },
  { re: /\bterraform\s+destroy/i, reason: "terraform destroy (tears down infrastructure)" },
  { re: /\bkubectl\s+delete/i, reason: "kubectl delete (removes cluster resources)" },
  { re: /\bdocker\s+(system\s+prune|volume\s+rm|rmi)\b/i, reason: "docker prune/remove (deletes images/volumes)" },
  { re: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, reason: "destructive SQL (DROP/TRUNCATE)" },
  { re: /\b(shutdown|reboot|halt|poweroff|stop-computer|restart-computer)\b/i, reason: "system power state change" },
  { re: /\breg\s+delete\b/i, reason: "registry delete (reg delete)" },
  { re: /\bremove-item\b[^|;&\n]*\bhk(lm|cu|cr|u):/i, reason: "registry delete (Remove-Item HKLM:/HKCU:)" },
  { re: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}/, reason: "fork bomb" },
  { re: /\bchmod\s+-[a-z]*r[a-z]*\s+\d{3,4}\s+\/(\s|$)/i, reason: "recursive chmod on /" },
  { re: /\bchmod\s+-[a-z]*r[a-z]*\s+(777|000)\b/i, reason: "recursive blanket chmod (777/000)" },
];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Commands that run the command after them, each with its own flags that take a value. */
const COMMAND_WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--close-from", "--command-timeout"]),
  doas: new Set(["-u", "-C"]),
  runas: new Set(),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  nohup: new Set(),
  time: new Set(["-f", "-o", "--format", "--output"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "--class", "--classdata"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-lines", "--max-procs"]),
  command: new Set(),
  builtin: new Set(),
  wsl: new Set(["-d", "-u", "--distribution", "--user", "--cd"]),
};

const PRIVILEGE_WRAPPERS = new Set(["sudo", "doas", "runas"]);

const EXEC_EXTENSION = /\.(exe|cmd|bat|ps1|com)$/i;

/** The name a command word runs: without quotes, folder or Windows extension, in lower case
 *  (`"C:\Python312\python.exe"` → `python`, `/sbin/mkfs.ext4` → `mkfs.ext4`). */
export function commandName(word: string): string {
  const unquoted = word.replace(/["']/g, "");
  const base = unquoted.split(/[\\/]/).pop() ?? unquoted;
  return base.toLowerCase().replace(EXEC_EXTENSION, "");
}

/** Whether a command only runs the one after it (`env`, `nohup`, `sudo`…), so it says nothing
 *  about what will run. */
export function isCommandWrapper(name: string): boolean {
  return Object.hasOwn(COMMAND_WRAPPERS, name);
}

/** What a segment runs, past variable assignments and wrappers (`sudo -n`, `env X=1`, `nohup`,
 *  `time`…): its words as the shell passes them on, and the wrappers it went through. */
function resolveCommand(segment: string): { words: string[]; wrappers: string[] } {
  const words = shellSegments(segment).flat();
  const wrappers: string[] = [];
  let i = 0;
  let lastWrapper = -1;
  while (i < words.length) {
    while (i < words.length && ASSIGNMENT.test(words[i])) i++;
    const name = commandName(words[i] ?? "");
    const valued = COMMAND_WRAPPERS[name];
    // `command -v x` only looks x up.
    if (!valued || (name === "command" && /^-[vV]$/.test(words[i + 1] ?? ""))) break;
    wrappers.push(name);
    lastWrapper = i++;
    while (i < words.length && (words[i].startsWith("-") || (name === "runas" && words[i].startsWith("/")))) {
      if (valued.has(words[i])) i++;
      i++;
    }
    if (name === "timeout" && /^\d/.test(words[i] ?? "")) i++;
  }
  // A wrapper with nothing after it (`env`, `time`) is the command itself.
  if (i >= words.length && lastWrapper >= 0) return { words: words.slice(lastWrapper), wrappers: wrappers.slice(0, -1) };
  return { words: words.slice(i), wrappers };
}

/** A segment as the command it runs: its name, then its arguments (`sudo -n /usr/bin/curl.exe x`
 *  → `curl x`). For matching rules written against the bare name. */
export function normalizeCommandSegment(segment: string): string {
  const { words } = resolveCommand(segment);
  return [commandName(words[0] ?? ""), ...words.slice(1)].join(" ").trim();
}

function firstToken(segment: string): string {
  return commandName(resolveCommand(segment).words[0] ?? "");
}

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "ash"]);

/** The command lines a segment hands to another shell: `bash -c "…"`, `cmd /c …`,
 *  `powershell -Command …`. */
function innerCommands(words: string[]): string[] {
  const name = commandName(words[0] ?? "");
  const rest = words.slice(1);
  const after = (at: number) => (at >= 0 && at + 1 < rest.length ? [rest.slice(at + 1).join(" ")] : []);
  if (SHELLS.has(name)) {
    const at = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/i.test(w));
    return at >= 0 && rest[at + 1] !== undefined ? [rest[at + 1]] : [];
  }
  if (name === "cmd") return after(rest.findIndex((w) => /^\/[ck]$/i.test(w)));
  if (name === "powershell" || name === "pwsh") {
    const at = rest.findIndex((w) => /^-(c|command)$/i.test(w));
    if (at >= 0) return after(at);
    // Windows PowerShell takes a command by default (pwsh a script file). Which word starts it
    // depends on its flags' values, so every place it could start is checked.
    if (name !== "powershell") return [];
    return rest.flatMap((w, i) => (w.startsWith("-") ? [] : [rest.slice(i).join(" ")]));
  }
  return [];
}

/** `format D:` or `mkfs…`, as the command itself rather than a word inside another one
 *  (`ffprobe -show_entries format=duration`, `git log --format=…`, `clang-format`). */
function formatsDisk(words: string[]): boolean {
  const name = commandName(words[0] ?? "");
  if (/^mkfs(\.\w+)?$/.test(name)) return true;
  return name === "format" && words.slice(1).some((w) => /^[a-z]:\\?$/i.test(w));
}

const MAX_SHELL_DEPTH = 3;

/** Why a command line is destructive, looking inside the shells it starts too; null when it isn't. */
function destructiveReason(cmd: string, depth = 0): string | null {
  for (const { re, reason } of DESTRUCTIVE_PATTERNS) {
    if (re.test(cmd)) return reason;
  }
  for (const seg of commandSegments(cmd)) {
    const { words } = resolveCommand(seg);
    if (formatsDisk(words)) return "filesystem format";
    if (depth >= MAX_SHELL_DEPTH) continue;
    for (const inner of innerCommands(words)) {
      const found = destructiveReason(inner, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** The first segment that runs code, the network or a privileged command, and what it runs. */
function dangerousSegment(segments: string[]): { base: string; segment: string } | null {
  for (const segment of segments) {
    const { words, wrappers } = resolveCommand(segment);
    const privileged = wrappers.find((w) => PRIVILEGE_WRAPPERS.has(w));
    if (privileged) return { base: privileged, segment };
    const base = commandName(words[0] ?? "");
    if (base && DANGEROUS_BASES.has(base)) return { base, segment };
  }
  return null;
}

function commandSegments(cmd: string): string[] {
  const subBodies: string[] = [];
  for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    subBodies.push(m[1] ?? m[2] ?? "");
  }
  const stripped = cmd.replace(/\$\([^()]*\)|`[^`]*`/g, " ");
  const top = stripped
    .split(/\n|;|&&|\|\||\||&/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...top, ...subBodies];
}

export function classifyCommand(cmd: string): CommandRiskResult {
  if (!cmd.trim()) return { risk: "safe" };
  const destructive = destructiveReason(cmd);
  if (destructive) return { risk: "destructive", reason: destructive };
  const dangerous = dangerousSegment(commandSegments(cmd));
  if (dangerous) return { risk: "dangerous", reason: `runs ${dangerous.base}` };
  return { risk: "safe" };
}

export type CommandIntent =
  | "read-only"
  | "write"
  | "destructive"
  | "network"
  | "process"
  | "package"
  | "system-admin"
  | "code-exec"
  | "unknown";

export type ValidatorName =
  | "readOnly"
  | "destructive"
  | "dangerousBase"
  | "pathTraversal"
  | "sedInPlace"
  | "redirection";

export interface CommandFinding {
  validator: ValidatorName;
  risk: CommandRisk;
  reason: string;
  segment?: string;
}

export interface AnalyzeOptions {
  readOnly?: boolean;
  workspaceRoot?: string;
}

export interface CommandAnalysis {
  risk: CommandRisk;
  reason?: string;
  intent: CommandIntent;
  findings: CommandFinding[];
}

const WRITE_COMMANDS = new Set([
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp",
  "ln", "install", "tee", "truncate", "shred", "mkfifo", "mknod", "dd",
  "copy", "move", "ren", "rename", "md", "rd", "del", "erase",
  "new-item", "set-content", "add-content", "remove-item", "out-file",
]);

const STATE_MODIFYING_COMMANDS = new Set([
  "apt", "apt-get", "yum", "dnf", "pacman", "brew", "pip", "pip3",
  "npm", "yarn", "pnpm", "bun", "cargo", "gem", "go", "rustup", "winget", "choco", "scoop",
  "docker", "systemctl", "service", "mount", "umount", "kill", "pkill",
  "killall", "reboot", "shutdown", "halt", "poweroff", "stop-process", "stop-service",
  "useradd", "userdel", "usermod", "groupadd", "groupdel", "crontab", "at", "schtasks",
]);

const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "sort", "uniq",
  "grep", "egrep", "fgrep", "rg", "find", "fd", "which", "whereis", "whatis", "man",
  "info", "file", "stat", "du", "df", "free", "uptime", "uname", "hostname",
  "whoami", "id", "groups", "env", "printenv", "echo", "printf", "date",
  "cal", "bc", "expr", "test", "true", "false", "pwd", "tree", "diff",
  "cmp", "md5sum", "sha256sum", "sha1sum", "xxd", "od", "hexdump", "strings",
  "readlink", "realpath", "basename", "dirname", "seq", "yes", "tput",
  "column", "jq", "yq", "tr", "cut", "paste",
  "get-content", "get-childitem", "get-item", "select-string", "dir", "type", "where",
]);

const NETWORK_COMMANDS = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "telnet", "nc", "ncat",
  "ftp", "iwr", "invoke-webrequest", "invoke-restmethod", "nslookup", "dig", "ping",
]);

const PROCESS_COMMANDS = new Set([
  "kill", "pkill", "killall", "ps", "top", "htop", "bg", "fg", "jobs", "nice", "renice",
  "stop-process", "get-process",
]);

const PACKAGE_COMMANDS = new Set([
  "apt", "apt-get", "yum", "dnf", "pacman", "brew", "pip", "pip3",
  "npm", "yarn", "pnpm", "bun", "cargo", "gem", "rustup", "winget", "choco", "scoop",
]);

const SYSTEM_ADMIN_COMMANDS = new Set([
  "sudo", "doas", "runas", "mount", "umount", "chmod", "chown", "chgrp",
  "useradd", "userdel", "usermod", "groupadd", "groupdel", "crontab",
  "systemctl", "service", "reboot", "shutdown", "halt", "poweroff", "reg", "schtasks",
]);

const CODE_EXEC_COMMANDS = new Set([
  "python", "python3", "node", "deno", "tsx", "ts-node", "ruby", "perl", "php",
  "lua", "rscript", "bash", "sh", "zsh", "fish", "pwsh", "powershell", "cmd",
  "eval", "exec", "source", "npx", "bunx", "pnpx", "iex", "invoke-expression",
]);

const GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show", "branch", "tag", "remote", "ls-files",
  "ls-tree", "cat-file", "rev-parse", "describe", "shortlog", "blame",
  "reflog", "config", "fetch",
]);

const SYSTEM_PATH_PREFIXES = [
  "/etc/", "/usr/", "/var/", "/boot/", "/sys/", "/proc/", "/dev/",
  "/sbin/", "/bin/", "/lib/", "/lib64/", "/opt/", "/root/",
];

const WRITE_REDIRECT_RE = /(?:^|[^0-9>])>>?(?!&)/;

function segmentIntent(segment: string): CommandIntent {
  const { words } = resolveCommand(segment);
  const base = commandName(words[0] ?? "");
  if (!base) return "unknown";
  if (base === "git") {
    const sub = words[1]?.toLowerCase() ?? "";
    return GIT_READ_ONLY.has(sub) ? "read-only" : "write";
  }
  if ((base === "sed" || base === "perl") && /\s-i\b/.test(segment)) return "write";
  if (base === "awk" && /\binplace\b/i.test(segment)) return "write";
  if (destructiveReason(segment)) return "destructive";
  if (CODE_EXEC_COMMANDS.has(base)) return "code-exec";
  if (NETWORK_COMMANDS.has(base)) return "network";
  if (PACKAGE_COMMANDS.has(base)) return "package";
  if (PROCESS_COMMANDS.has(base)) return "process";
  if (SYSTEM_ADMIN_COMMANDS.has(base)) return "system-admin";
  if (WRITE_COMMANDS.has(base) || STATE_MODIFYING_COMMANDS.has(base)) return "write";
  if (READ_ONLY_COMMANDS.has(base)) return "read-only";
  return "unknown";
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function validateReadOnly(segments: string[], opts: AnalyzeOptions): CommandFinding[] {
  if (!opts.readOnly) return [];
  const out: CommandFinding[] = [];
  for (const raw of segments) {
    const seg = raw;
    const { words } = resolveCommand(seg);
    const base = commandName(words[0] ?? "");
    if (!base) continue;
    let reason = "";
    if (base === "git") {
      const sub = words[1]?.toLowerCase() ?? "";
      if (sub && !GIT_READ_ONLY.has(sub)) reason = `git ${sub} modifies the repository`;
    } else if (WRITE_COMMANDS.has(base)) {
      reason = `${base} writes to the filesystem`;
    } else if (STATE_MODIFYING_COMMANDS.has(base)) {
      reason = `${base} modifies system state`;
    } else if ((base === "sed" || base === "perl") && /\s-i\b/.test(seg)) {
      reason = `${base} -i edits files in place`;
    } else if (WRITE_REDIRECT_RE.test(seg)) {
      reason = "redirects output to a file";
    }
    if (reason) out.push({ validator: "readOnly", risk: "dangerous", reason, segment: raw });
  }
  return out;
}

function validateDestructive(cmd: string): CommandFinding[] {
  const reason = destructiveReason(cmd);
  return reason ? [{ validator: "destructive", risk: "destructive", reason }] : [];
}

function validateDangerousBase(segments: string[]): CommandFinding[] {
  const found = dangerousSegment(segments);
  return found ? [{ validator: "dangerousBase", risk: "dangerous", reason: `runs ${found.base}`, segment: found.segment }] : [];
}

function validatePathTraversal(cmd: string, segments: string[], opts: AnalyzeOptions): CommandFinding[] {
  const out: CommandFinding[] = [];
  const norm = normalizeSlashes(cmd);

  if (/(?:^|[\s"'=(/])\.\.(?:\/|\\|$|\s)/.test(cmd)) {
    out.push({
      validator: "pathTraversal",
      risk: "dangerous",
      reason: "path traversal with `..` (may escape the workspace)",
    });
  }

  if (/(?:^|\s)~\//.test(cmd) || /\$HOME\b|\$\{HOME\}|%USERPROFILE%/i.test(cmd)) {
    out.push({
      validator: "pathTraversal",
      risk: "dangerous",
      reason: "references the home directory (outside the workspace)",
    });
  }

  const touchesSystemPath = SYSTEM_PATH_PREFIXES.some((p) => norm.includes(p));
  if (touchesSystemPath) {
    const writes = segments.some((seg) => {
      const base = firstToken(seg);
      return WRITE_COMMANDS.has(base) || STATE_MODIFYING_COMMANDS.has(base) || WRITE_REDIRECT_RE.test(seg);
    });
    if (writes) {
      out.push({
        validator: "pathTraversal",
        risk: "destructive",
        reason: "writes to a protected system path (/etc, /usr, /var…)",
      });
    }
  }

  if (opts.workspaceRoot) {
    const root = normalizeSlashes(opts.workspaceRoot).replace(/\/+$/, "").toLowerCase();
    for (const m of norm.matchAll(/(?:^|[\s"'=])((?:[A-Za-z]:)?\/[^\s"';|&]+)/g)) {
      const abs = m[1].toLowerCase();
      if (SYSTEM_PATH_PREFIXES.some((p) => abs.startsWith(p))) continue;
      if (!abs.startsWith(root + "/") && abs !== root) {
        out.push({
          validator: "pathTraversal",
          risk: "dangerous",
          reason: `absolute path outside the workspace (${m[1]})`,
        });
        break;
      }
    }
  }

  return out;
}

function validateSedInPlace(segments: string[]): CommandFinding[] {
  for (const seg of segments) {
    const base = firstToken(seg);
    if ((base === "sed" || base === "perl") && /\s-i\b/.test(seg)) {
      const massEdit = /\bd\s*['"]?\s*$/.test(seg) || /-i[^\s]*\s+.*\*/.test(seg) || /s\/[^/]*\/[^/]*\/g/.test(seg);
      return [{
        validator: "sedInPlace",
        risk: massEdit ? "destructive" : "dangerous",
        reason: massEdit ? `${base} -i mass in-place edit` : `${base} -i edits files in place`,
        segment: seg,
      }];
    }
    if (base === "awk" && /\binplace\b/i.test(seg)) {
      return [{ validator: "sedInPlace", risk: "dangerous", reason: "awk in-place edit", segment: seg }];
    }
  }
  return [];
}

function validateRedirection(segments: string[]): CommandFinding[] {
  for (const seg of segments) {
    const norm = normalizeSlashes(seg);
    const m = /(>>?)\s*((?:[A-Za-z]:)?\/?[^\s"';|&]+)/.exec(norm);
    if (!m) continue;
    const target = m[2];
    if (/^\/dev\//i.test(target)) {
      return [{ validator: "redirection", risk: "destructive", reason: "redirect to a device file (/dev/…)", segment: seg }];
    }
    if (SYSTEM_PATH_PREFIXES.some((p) => target.startsWith(p))) {
      return [{ validator: "redirection", risk: "destructive", reason: `redirect overwrites a system path (${target})`, segment: seg }];
    }
  }
  return [];
}

const RISK_ORDER: Record<CommandRisk, number> = { safe: 0, dangerous: 1, destructive: 2 };

export function analyzeCommand(cmd: string, opts: AnalyzeOptions = {}): CommandAnalysis {
  if (!cmd.trim()) return { risk: "safe", intent: "unknown", findings: [] };

  const segments = commandSegments(cmd);
  const findings: CommandFinding[] = [
    ...validateDestructive(cmd),
    ...validateRedirection(segments),
    ...validateSedInPlace(segments),
    ...validatePathTraversal(cmd, segments, opts),
    ...validateReadOnly(segments, opts),
    ...validateDangerousBase(segments),
  ];

  let risk: CommandRisk = "safe";
  let reason: string | undefined;
  for (const f of findings) {
    if (RISK_ORDER[f.risk] > RISK_ORDER[risk]) {
      risk = f.risk;
      reason = f.reason;
    }
  }

  return {
    risk,
    reason,
    intent: segmentIntent(segments[0] ?? cmd),
    findings,
  };
}

export function classifyIntent(cmd: string): CommandIntent {
  const segments = commandSegments(cmd);
  return segmentIntent(segments[0] ?? cmd);
}

export function violatesReadOnly(cmd: string): boolean {
  return validateReadOnly(commandSegments(cmd), { readOnly: true }).length > 0;
}

const AUTO_READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "which", "whereis", "file", "stat",
  "du", "df", "pwd", "tree", "diff", "cmp", "basename", "dirname", "realpath", "readlink",
  "echo", "uname", "whoami", "hostname", "date", "md5sum", "sha256sum", "sha1sum",
  "get-childitem", "get-content", "get-item", "get-location", "select-string", "test-path",
  "resolve-path", "get-command", "dir", "type", "where", "where.exe", "gci", "gc", "sls",
]);

const AUTO_GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show", "ls-files", "ls-tree", "cat-file", "rev-parse", "describe",
  "shortlog", "blame", "--version", "version",
]);

const AUTO_UNSAFE_SYNTAX = /[`$<>{}()\n\r]|(?:^|[^&])&(?!&)/;
const AUTO_UNSAFE_FLAG = /^-(o|O|-output|-pre|-exec|-ext-diff|-textconv)(=|$)/;

export function isAutoApprovableReadOnly(cmd: string): boolean {
  if (!cmd.trim() || AUTO_UNSAFE_SYNTAX.test(cmd)) return false;
  const segments = cmd.split(/&&|\|\||\||;/).map((s) => s.trim());
  if (segments.some((s) => !s)) return false;
  return segments.every((segment) => {
    // Words as the shell passes them on, so a flag can't hide behind quotes ("--output=x",
    // --out""put=x) or a backslash (\--output=x).
    const tokens = shellSegments(segment).flat();
    if (!tokens.length) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return false;
    if (tokens.some((t) => AUTO_UNSAFE_FLAG.test(t.replace(/\\/g, "")))) return false;
    const base = tokens[0].toLowerCase().replace(/^.*[\\/]/, "");
    if (base === "git" || base === "git.exe") return AUTO_GIT_READ_ONLY.has(tokens[1] ?? "");
    return AUTO_READ_ONLY_COMMANDS.has(base);
  });
}
