import { describe, it, expect } from "vitest";
import { buildRecentsGroups, DEFAULT_RECENTS_FILTER, isRecentsFilterActive } from "@/lib/recentsFilter";
import type { SessionSummary } from "@/lib/sessionStorage";
import { shortAge } from "@/lib/time";
import { getTranslations } from "@/lib/i18n";

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const session = (id: string, workspace: string | undefined, hoursAgo: number): SessionSummary => ({
  id,
  title: id,
  createdAt: NOW - hoursAgo * HOUR,
  modifiedAt: NOW - hoursAgo * HOUR,
  messageCount: 2,
  workspace,
});

describe("Recents grouped by project", () => {
  it("is the default view", () => {
    expect(DEFAULT_RECENTS_FILTER.groupBy).toBe("project");
    expect(isRecentsFilterActive(DEFAULT_RECENTS_FILTER)).toBe(false);
  });

  it("puts each session under its folder, most recently used folder first", () => {
    const groups = buildRecentsGroups(
      [session("a", "D:\\optimicer", 30), session("b", "D:\\storefront", 2), session("c", "D:\\optimicer", 1)],
      [],
      DEFAULT_RECENTS_FILTER,
      NOW,
    );
    expect(groups.map((g) => [g.label, g.items.map((s) => s.id)])).toEqual([
      ["optimicer", ["c", "a"]],
      ["storefront", ["b"]],
    ]);
    expect(groups[0].workspace).toBe("D:\\optimicer");
  });

  it("lists folders without sessions after the others, and sessions without a folder last", () => {
    const groups = buildRecentsGroups(
      [session("a", "D:\\optimicer", 5), session("loose", undefined, 1)],
      [],
      DEFAULT_RECENTS_FILTER,
      NOW,
      undefined,
      ["D:\\optimicer", "D:\\zeta", "D:\\alpha"],
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["optimicer", 1],
      ["alpha", 0],
      ["zeta", 0],
      ["No folder", 1],
    ]);
  });

  it("leaves empty folders out when the list is narrowed down", () => {
    const groups = buildRecentsGroups([session("a", "D:\\optimicer", 5)], [], { ...DEFAULT_RECENTS_FILTER, activity: "1d" }, NOW, undefined, ["D:\\zeta"]);
    expect(groups.map((g) => g.label)).toEqual(["optimicer"]);
  });
});

describe("shortAge", () => {
  it("says how long ago in one short token", () => {
    expect(shortAge(NOW - 20_000, NOW)).toBe("now");
    expect(shortAge(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(shortAge(NOW - 3 * HOUR, NOW)).toBe("3h");
    expect(shortAge(NOW - 7 * 24 * HOUR, NOW)).toBe("1w");
    expect(shortAge(NOW - 6 * 24 * HOUR, NOW)).toBe("6d");
    expect(shortAge(NOW - 400 * 24 * HOUR, NOW)).toBe("1y");
  });
});

describe("Recents group names", () => {
  const es = getTranslations("es-ES").recentsGroups;

  it("come in the app's language", () => {
    const byDate = buildRecentsGroups([session("a", "D:/app", 1)], [], { ...DEFAULT_RECENTS_FILTER, groupBy: "date" }, NOW, undefined, [], es);
    expect(byDate.map((g) => g.label)).toEqual(["Hoy"]);
    const byProject = buildRecentsGroups([session("loose", undefined, 1)], [], DEFAULT_RECENTS_FILTER, NOW, undefined, [], es);
    expect(byProject.map((g) => g.label)).toEqual(["Sin carpeta"]);
    const byState = buildRecentsGroups([session("a", "D:/app", 1)], [], { ...DEFAULT_RECENTS_FILTER, groupBy: "state" }, NOW, { a: "blocked" }, [], es);
    expect(byState.map((g) => g.label)).toEqual(["Bloqueada"]);
  });

  it("don't call an archived session without a PR merged or closed", () => {
    const withPr = { ...session("pr", "D:/app", 2), archived: true, prs: [{ url: "https://github.com/a/b/pull/1", host: "github.com", repo: "a/b", number: 1, source: "printed" as const, linkedAt: NOW }] };
    const plain = { ...session("plain", "D:/app", 1), archived: true };
    const groups = buildRecentsGroups([], [withPr, plain], { ...DEFAULT_RECENTS_FILTER, status: "archived", groupBy: "prStatus" }, NOW);
    expect(groups.map((g) => [g.key, g.items.map((s) => s.id)])).toEqual([
      ["merged", ["pr"]],
      ["nopr", ["plain"]],
    ]);
  });
});
