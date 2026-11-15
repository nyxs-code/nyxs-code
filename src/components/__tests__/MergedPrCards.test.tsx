// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MergedPrCards } from "@/components/MergedPrCards";
import {
  addMergedPrCard,
  dismissMergedPrCards,
  resetMergedPrCardsForTests,
  useMergedPrCards,
  type MergedPrCard,
} from "@/lib/mergedPrCards";
import { mergedPrsFromTool } from "@/lib/prArchive";

const card = (n: number, minutesAgo = 1): MergedPrCard => ({
  url: `https://github.com/acme/app/pull/${n}`,
  number: n,
  base: "main",
  mergedAt: Date.now() - minutesAgo * 60_000,
});

beforeEach(() => {
  localStorage.clear();
  resetMergedPrCardsForTests();
});
afterEach(cleanup);

describe("mergedPrsFromTool", () => {
  it("reads the PRs gh says it merged", () => {
    const out = "✓ Squashed and merged pull request acme/app#405 (Companion follows its case manager)\n✓ Deleted branch alex/x";
    expect(mergedPrsFromTool("Bash gh pr merge 405 --squash --delete-branch", out)).toEqual([{ repo: "acme/app", number: 405 }]);
  });

  it("takes the repo from -R when gh doesn't print it", () => {
    expect(mergedPrsFromTool("Bash gh pr merge 12 -R acme/app --merge", "✓ Merged pull request #12 (Fix)")).toEqual([{ repo: "acme/app", number: 12 }]);
  });

  it("ignores a merge that was only queued, and commands that merely mention one", () => {
    expect(mergedPrsFromTool("Bash gh pr merge 7 --auto", "✓ Pull request acme/app#7 will be automatically merged via squash when all requirements are met")).toEqual([]);
    expect(mergedPrsFromTool("Bash git log --grep 'gh pr merge'", "Merged pull request #3")).toEqual([]);
  });
});

describe("merged PR cards store", () => {
  it("keeps the newest first and never brings back a dismissed one", () => {
    const { result } = renderHook(() => useMergedPrCards("chat-1"));
    act(() => {
      addMergedPrCard("chat-1", card(402, 30));
      addMergedPrCard("chat-1", card(405, 1));
      addMergedPrCard("chat-1", card(405, 1));
    });
    expect(result.current.map((c) => c.number)).toEqual([405, 402]);
    act(() => dismissMergedPrCards("chat-1", [card(405).url]));
    act(() => addMergedPrCard("chat-1", card(405, 1)));
    expect(result.current.map((c) => c.number)).toEqual([402]);
  });

  it("skips a merge older than a day", () => {
    addMergedPrCard("chat-1", card(1, 25 * 60));
    const { result } = renderHook(() => useMergedPrCards("chat-1"));
    expect(result.current).toEqual([]);
  });
});

describe("MergedPrCards", () => {
  const four = [card(405), card(404), card(403), card(402)];

  it("shows a single PR as one card", () => {
    render(<MergedPrCards cards={[card(412)]} onDismiss={() => {}} />);
    expect(screen.getByText("PR #412 merged into main")).toBeTruthy();
    expect(screen.queryByText("+0")).toBeNull();
  });

  it("stacks several collapsed, the newest in front, and closes them all at once", () => {
    const onDismiss = vi.fn();
    render(<MergedPrCards cards={four} onDismiss={onDismiss} />);
    expect(screen.getByText("PR #405 merged into main")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.queryByText("PR #404 merged into main")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    expect(onDismiss).toHaveBeenCalledWith(four.map((c) => c.url));
  });

  it("spreads out on click, closes one at a time and collapses back", () => {
    const onDismiss = vi.fn();
    render(<MergedPrCards cards={four} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the 4 merged PRs" }));
    expect(screen.getByText("PR #402 merged into main")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[1]);
    expect(onDismiss).toHaveBeenCalledWith([four[1].url]);
    fireEvent.click(screen.getByRole("button", { name: /Collapse/ }));
    expect(screen.getByText("+3")).toBeTruthy();
  });
});
