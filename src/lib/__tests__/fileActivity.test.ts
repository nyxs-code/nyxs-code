import { describe, it, expect } from "vitest";
import { ACTIVITY_SLACK_MS, contestedShellFiles, createFileActivityLog, noteToolActivity } from "@/lib/fileActivity";

function clockedLog(start = 1_000_000) {
  let clock = start;
  const log = createFileActivityLog(() => clock);
  return { log, at: (t: number) => (clock = t) };
}

describe("file activity log", () => {
  it("finds the files someone else was editing during a window, never the owner's own", () => {
    const { log, at } = clockedLog();
    at(1_000_000);
    log.editing("other", "C:\\proj\\src\\A.ts");
    log.editing("me", "C:/proj/src/b.ts");
    at(1_050_000);
    log.end("other");
    log.end("me");
    expect(log.contested("me", ["C:/proj/src/a.ts", "C:/proj/src/b.ts"], 1_010_000, 1_020_000)).toEqual(["C:/proj/src/a.ts"]);
    expect(log.contested("other", ["C:/proj/src/b.ts"], 1_010_000, 1_020_000)).toEqual(["C:/proj/src/b.ts"]);
  });

  it("keeps an edit span open until the turn ends", () => {
    const { log, at } = clockedLog();
    log.editing("other", "/p/a.ts");
    at(9_000_000);
    expect(log.contested("me", ["/p/a.ts"], 8_000_000, 8_100_000)).toEqual(["/p/a.ts"]);
    log.end("other");
    at(9_100_000);
    expect(log.contested("me", ["/p/a.ts"], 9_050_000, 9_060_000)).toEqual([]);
  });

  it("allows for the slack between an event and the write it stands for", () => {
    const { log, at } = clockedLog();
    at(1_000_000);
    log.wrote("user", "/p/a.ts");
    const end = 1_000_000 - ACTIVITY_SLACK_MS;
    expect(log.contested("me", ["/p/a.ts"], end - 5_000, end)).toEqual(["/p/a.ts"]);
    expect(log.contested("me", ["/p/a.ts"], end - 5_000, end - 1)).toEqual([]);
    expect(log.contested("me", ["/p/a.ts"], 1_000_000 + ACTIVITY_SLACK_MS + 1, 1_010_000)).toEqual([]);
  });

  it("contests every file while another session runs something whose files are unknown", () => {
    const { log, at } = clockedLog();
    noteToolActivity(log, "other", "t1", { name: "Agent", detail: "Refactor the parser" });
    at(1_100_000);
    expect(log.contested("me", ["/p/a.ts", "/p/b.ts"], 1_050_000, 1_060_000)).toEqual(["/p/a.ts", "/p/b.ts"]);
    noteToolActivity(log, "other", "t1", { name: "Agent", detail: "Refactor the parser", endedAt: 1 });
    at(1_200_000);
    expect(log.contested("me", ["/p/a.ts"], 1_150_000, 1_160_000)).toEqual([]);
  });

  it("ignores read-only commands and tools that write nothing", () => {
    const { log } = clockedLog();
    noteToolActivity(log, "other", "t1", { name: "Bash", detail: "git diff --stat" });
    noteToolActivity(log, "other", "t2", { name: "Read", detail: "/p/a.ts" });
    noteToolActivity(log, "other", "t3", { name: "Grep", detail: "TODO" });
    expect(log.contested("me", ["/p/a.ts"], 0, 2_000_000)).toEqual([]);
  });

  it("keeps a background command open after its call returns, until the turn ends", () => {
    const { log, at } = clockedLog();
    const detail = { name: "Bash", detail: "npm run watch  (background)" };
    noteToolActivity(log, "other", "t1", detail);
    noteToolActivity(log, "other", "t1", { ...detail, endedAt: 1 });
    at(1_500_000);
    expect(log.contested("me", ["/p/dist/a.js"], 1_400_000, 1_410_000)).toEqual(["/p/dist/a.js"]);
    log.end("other");
    at(1_600_000);
    expect(log.contested("me", ["/p/dist/a.js"], 1_550_000, 1_560_000)).toEqual([]);
  });

  it("judges a command's change by its workspace-relative files, and not one saved without times", () => {
    const { log } = clockedLog();
    log.editing("other", "C:\\proj\\src\\a.ts");
    const change = { before: "t0", after: "t1", files: ["src/a.ts", "gen.txt"] };
    expect(contestedShellFiles(log, "me", "C:\\proj\\", { ...change, startedAt: 1_000_000, endedAt: 1_000_500 })).toEqual(["src/a.ts"]);
    expect(contestedShellFiles(log, "me", "C:\\proj", change)).toEqual([]);
  });
});
