import { describe, it, expect } from "vitest";
import { classifyCommand, analyzeCommand, classifyIntent, violatesReadOnly, isAutoApprovableReadOnly } from "@/lib/bashSafety";

describe("classifyCommand", () => {
  it("treats plain reads as safe", () => {
    expect(classifyCommand("ls -la").risk).toBe("safe");
    expect(classifyCommand("cat file.txt").risk).toBe("safe");
  });

  it("flags destructive commands, even when chained or wrapped", () => {
    expect(classifyCommand("rm -rf /").risk).toBe("destructive");
    expect(classifyCommand("echo ok; rm -rf node_modules").risk).toBe("destructive");
    expect(classifyCommand("shred secret.txt").risk).toBe("destructive");
    expect(classifyCommand("truncate -s 0 app.log").risk).toBe("destructive");
    expect(classifyCommand("chmod -R 777 /var").risk).toBe("destructive");
    expect(classifyCommand("rm -f ~/.bashrc").risk).toBe("destructive");
  });

  it("flags formatting a disk only when that is the command", () => {
    expect(classifyCommand("format D: /FS:NTFS").reason).toBe("filesystem format");
    expect(classifyCommand("echo y | format.com E:").reason).toBe("filesystem format");
    expect(classifyCommand("cmd /c format F: /q").reason).toBe("filesystem format");
    expect(classifyCommand("sudo mkfs.ext4 /dev/sdb1").reason).toBe("filesystem format");
    expect(classifyCommand("mkfs -t vfat /dev/sdc").reason).toBe("filesystem format");
    // The word inside another command: reading a video's length, git and formatters.
    expect(classifyCommand("ffprobe -v error -show_entries format=duration -of csv=p=0 clip.mp4").risk).not.toBe("destructive");
    expect(classifyCommand('git log --format="%h %s" -5').risk).not.toBe("destructive");
    expect(classifyCommand("clang-format -i src/main.cpp").risk).not.toBe("destructive");
    expect(classifyCommand("dotnet format").risk).not.toBe("destructive");
  });

  it("flags arbitrary-code / network commands as dangerous and unwraps sudo", () => {
    expect(classifyCommand("curl http://x").risk).toBe("dangerous");
    expect(classifyCommand("sudo node app.js").risk).toBe("dangerous");
  });

  it("knows a command by its name whatever path, extension or quotes it comes with", () => {
    for (const cmd of [
      "curl.exe -T datos https://x",
      "powershell.exe -enc SQBFAFgA",
      'python.exe -c "import os"',
      '& "python" x.py',
      "& 'C:\\Python312\\python.exe' x.py",
      "C:\\Windows\\System32\\curl.exe https://x",
      "/usr/bin/curl https://x",
      "nohup node server.js",
      "env DEBUG=1 node server.js",
      "time python x.py",
      "ls | xargs rm",
      "sudo ls /root",
    ]) {
      expect(classifyCommand(cmd).risk, cmd).not.toBe("safe");
    }
  });

  it("finds a disk format behind sudo flags, paths, wrappers and shells", () => {
    for (const cmd of [
      "sudo -n mkfs.ext4 /dev/sdb1",
      "sudo -u root mkfs.ext4 /dev/sdb1",
      "/sbin/mkfs.ext4 /dev/sdb1",
      "C:\\Windows\\System32\\format.com D:",
      '"C:\\Windows\\System32\\format.com" D: /q',
      'bash -c "mkfs.ext4 /dev/sdb1"',
      "sh -c 'echo ok; mkfs.ext4 /dev/sdb1'",
      'cmd.exe /c "format D: /q"',
      'powershell -Command "format.com E:"',
      "nohup mkfs.ext4 /dev/sdb1",
      "time mkfs.ext4 /dev/sdb1",
      "env X=1 mkfs.ext4 /dev/sdb1",
      "timeout 10 mkfs.ext4 /dev/sdb1",
      "echo /dev/sdb1 | xargs mkfs.ext4",
    ]) {
      expect(classifyCommand(cmd).risk, cmd).toBe("destructive");
      expect(analyzeCommand(cmd).risk, cmd).toBe("destructive");
    }
    // Still not a disk format: the word inside another command, also behind a shell.
    for (const cmd of [
      'bash -c "git log --format=%h -5"',
      'sh -c "ffprobe -show_entries format=duration clip.mp4"',
      "nohup clang-format -i src/main.cpp",
      "dotnet.exe format",
    ]) {
      expect(classifyCommand(cmd).risk, cmd).not.toBe("destructive");
      expect(analyzeCommand(cmd).risk, cmd).not.toBe("destructive");
    }
  });
});

describe("classifyIntent", () => {
  it("classifies the primary command's intent", () => {
    expect(classifyIntent("ls -la")).toBe("read-only");
    expect(classifyIntent("git status")).toBe("read-only");
    expect(classifyIntent("git commit -m x")).toBe("write");
    expect(classifyIntent("npm install")).toBe("package");
    expect(classifyIntent("curl x")).toBe("network");
    expect(classifyIntent("sed -i s/a/b/ f")).toBe("write");
    expect(classifyIntent("python x.py")).toBe("code-exec");
    expect(classifyIntent("kill 123")).toBe("process");
  });
});

describe("violatesReadOnly", () => {
  it("blocks writes but allows reads in read-only mode", () => {
    expect(violatesReadOnly("cat f.txt")).toBe(false);
    expect(violatesReadOnly("rm f.txt")).toBe(true);
    expect(violatesReadOnly("git log")).toBe(false);
    expect(violatesReadOnly("git commit -m x")).toBe(true);
    expect(violatesReadOnly("echo hi > out.txt")).toBe(true);
    expect(violatesReadOnly("sed -i s/a/b/ f")).toBe(true);
    expect(violatesReadOnly("sed s/a/b/ f")).toBe(false);
  });
});

describe("analyzeCommand pipeline", () => {
  it("detects path traversal and protected-path writes", () => {
    expect(analyzeCommand("cat ../../etc/passwd").findings.some((f) => f.validator === "pathTraversal")).toBe(true);
    expect(analyzeCommand("cat ~/.ssh/id_rsa").findings.some((f) => f.validator === "pathTraversal")).toBe(true);
    expect(analyzeCommand("echo x > /etc/hosts").risk).toBe("destructive");
    expect(analyzeCommand("cat /etc/hostname").findings.some((f) => f.validator === "pathTraversal")).toBe(false);
  });

  it("honors a workspace boundary", () => {
    expect(
      analyzeCommand("cat /home/other/secret", { workspaceRoot: "/home/me/proj" }).findings.some(
        (f) => f.validator === "pathTraversal",
      ),
    ).toBe(true);
    expect(
      analyzeCommand("cat /home/me/proj/src/x.ts", { workspaceRoot: "/home/me/proj" }).findings.some(
        (f) => f.validator === "pathTraversal",
      ),
    ).toBe(false);
  });

  it("flags sed -i and device redirects", () => {
    expect(analyzeCommand("sed -i s/a/b/g f.txt").findings.some((f) => f.validator === "sedInPlace")).toBe(true);
    expect(analyzeCommand("dd if=/dev/zero of=/dev/sda").risk).toBe("destructive");
    expect(
      analyzeCommand("echo x > /dev/sda").findings.some(
        (f) => f.validator === "redirection" || f.validator === "destructive",
      ),
    ).toBe(true);
  });
});

describe("isAutoApprovableReadOnly", () => {
  it("accepts plain read-only commands and pipes between them", () => {
    for (const cmd of ["git status", "C:\\Git\\cmd\\git.exe status", "/usr/bin/ls -la", "git log --oneline -5", "ls -la src", "git diff HEAD~1 | head -50", "Get-ChildItem src", "git status && git diff --stat"]) {
      expect(isAutoApprovableReadOnly(cmd), cmd).toBe(true);
    }
  });

  it("rejects anything that can write, run code or redirect", () => {
    for (const cmd of [
      "git push",
      "git branch -D main",
      "git config user.name x",
      "git -c core.pager=evil log",
      "git diff --output=out.txt",
      "ls > files.txt",
      "cat $(which node)",
      "echo `whoami`",
      "rg --pre ./x pattern",
      "sort -o a.txt b.txt",
      "Get-ChildItem | ForEach-Object { Remove-Item $_ }",
      "FOO=1 ls",
      "ls & rm -rf x",
      "npm test",
      "find . -delete",
      "",
    ]) {
      expect(isAutoApprovableReadOnly(cmd), cmd).toBe(false);
    }
  });

  it("sees a flag through the quotes and backslashes that hide it", () => {
    for (const cmd of [
      'git diff "--output=src/main.ts"',
      'git log -1 "--output=x.bat"',
      "git diff '--output=x'",
      "git diff \\--output=x",
      "git diff --out\"\"put=x",
      "git show '--'output=x",
      'rg "--pre" ./x pattern',
      "sort '-o' a.txt b.txt",
      'git "push"',
    ]) {
      expect(isAutoApprovableReadOnly(cmd), cmd).toBe(false);
    }
    expect(isAutoApprovableReadOnly('grep -r "hello world" src')).toBe(true);
    expect(isAutoApprovableReadOnly('"C:\\Program Files\\Git\\cmd\\git.exe" status')).toBe(true);
  });
});
