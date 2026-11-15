import { describe, it, expect } from "vitest";
import { classifyGitFailure } from "@/lib/gitErrors";

describe("classifyGitFailure", () => {
  it("recognises a repository git refuses to trust and keeps its path", () => {
    const stderr =
      "fatal: detected dubious ownership in repository at 'D:/projects/app'\n'D:/projects/app' is owned by:\n\t(inconvertible)\n";
    expect(classifyGitFailure(stderr)).toEqual({ kind: "untrusted", path: "D:/projects/app" });
  });

  it("tells a missing repository from one without commits", () => {
    expect(classifyGitFailure("fatal: not a git repository (or any of the parent directories): .git")).toEqual({ kind: "not-repo" });
    expect(
      classifyGitFailure("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."),
    ).toEqual({ kind: "no-commits" });
  });

  it("detects that git itself is not installed", () => {
    expect(classifyGitFailure("Couldn't start the command: program not found")).toEqual({ kind: "missing-git" });
  });

  it("passes other errors through so the user sees the real cause", () => {
    expect(classifyGitFailure("fatal: index file corrupt")).toEqual({ kind: "other", message: "fatal: index file corrupt" });
  });
});
