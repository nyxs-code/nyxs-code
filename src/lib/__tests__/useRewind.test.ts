// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { Chat } from "@/lib/chatStore";

const fileHistoryRewind = vi.fn(async (..._args: unknown[]): Promise<{ changed: number; kept: string[]; failed?: string[] }> => ({ changed: 0, kept: [] }));
const fileHistoryRewindPreview = vi.fn(async (..._args: unknown[]) => ({ files: 0, added: 0, removed: 0, paths: [], kept: [] }));
vi.mock("@/lib/fileHistory", () => ({
  fileHistoryRewind: (...args: unknown[]) => fileHistoryRewind(...args),
  fileHistoryRewindPreview: (...args: unknown[]) => fileHistoryRewindPreview(...args),
}));

const { useRewind } = await import("@/lib/useRewind");
const { FileNoticeBanner } = await import("@/components/FileNoticeBanner");
const { dismissFileNotice } = await import("@/lib/fileNotices");
const { setLanguage } = await import("@/lib/i18n");

beforeAll(() => setLanguage("es-ES"));

afterEach(() => {
  cleanup();
  act(() => dismissFileNotice());
});

const plainChat = (): Chat => ({ id: "c3", title: "t", workspace: "C:/proj", messages: [{ id: "m1", role: "user", content: "hi" } as Chat["messages"][number]] });

function setup(chat: Chat) {
  const fh = new Map([[chat.id, { snapshots: [], trackedFiles: new Set<string>(), snapshotSequence: 0 }]]);
  return renderHook(() =>
    useRewind({
      activeId: chat.id,
      chats: [chat],
      setChats: () => {},
      workspace: "C:/proj",
      fhRef: { current: fh },
      fhUpdater: () => () => {},
      fillInputRef: { current: null },
      setDiffNonce: () => {},
    }),
  );
}

describe("useRewind", () => {
  it("rewinds a worktree session in its worktree, where its turns kept their backups", async () => {
    const chat: Chat = {
      id: "c1",
      title: "t",
      workspace: "C:/proj",
      messages: [{ id: "m1", role: "user", content: "hi" } as Chat["messages"][number]],
      worktree: { path: "C:/wt/proj/c1", branch: "Nyxs/c1" },
    };
    const { result } = setup(chat);
    act(() => result.current.revertTo("m1"));
    expect(fileHistoryRewindPreview.mock.calls[0][1]).toBe("C:/wt/proj/c1");
    await act(() => result.current.confirmRewind("code"));
    expect(fileHistoryRewind.mock.calls[0][1]).toBe("C:/wt/proj/c1");
  });

  it("rewinds a session without a worktree in the project", async () => {
    fileHistoryRewind.mockClear();
    const chat: Chat = { id: "c2", title: "t", workspace: "C:/proj", messages: [{ id: "m1", role: "user", content: "hi" } as Chat["messages"][number]] };
    const { result } = setup(chat);
    act(() => result.current.revertTo("m1"));
    await act(() => result.current.confirmRewind("code"));
    expect(fileHistoryRewind.mock.calls[0][1]).toBe("C:/proj");
  });

  it("lists in the corner card the files a rewind couldn't put back", async () => {
    fileHistoryRewind.mockResolvedValueOnce({ changed: 1, kept: [], failed: ["src/a.ts", "src/b.ts"] });
    render(createElement(FileNoticeBanner));
    const { result } = setup(plainChat());
    act(() => result.current.revertTo("m1"));
    await act(() => result.current.confirmRewind("code"));
    expect(screen.getByText("No se pudieron restaurar 2 archivos")).toBeTruthy();
    expect(screen.getByText("Se quedan como estaban; el resto sí se restauró.")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("says it in the singular for one file", async () => {
    fileHistoryRewind.mockResolvedValueOnce({ changed: 0, kept: [], failed: ["a.ts"] });
    render(createElement(FileNoticeBanner));
    const { result } = setup(plainChat());
    act(() => result.current.revertTo("m1"));
    await act(() => result.current.confirmRewind("code"));
    expect(screen.getByText("No se pudo restaurar 1 archivo")).toBeTruthy();
  });

  it("shows nothing when every file was put back", async () => {
    fileHistoryRewind.mockResolvedValueOnce({ changed: 2, kept: [] });
    const { container } = render(createElement(FileNoticeBanner));
    const { result } = setup(plainChat());
    act(() => result.current.revertTo("m1"));
    await act(() => result.current.confirmRewind("code"));
    expect(container.textContent).toBe("");
  });
});
