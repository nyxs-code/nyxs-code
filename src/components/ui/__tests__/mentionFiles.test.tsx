// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));

const { useComposerSuggestions } = await import("@/components/ui/chat-input/useComposerSuggestions");
const { useProjectCommands } = await import("@/lib/useProjectCommands");

function suggestions(onListFiles: () => Promise<string[]>) {
  const textareaRef = { current: document.createElement("textarea") };
  const view = renderHook(() =>
    useComposerSuggestions({ textareaRef, setMessage: () => {}, pendingCursorRef: { current: null }, workspace: "E:/ws", onListFiles, commands: [] }),
  );
  /** The user typed `value`, the caret at its end. */
  const type = (value: string) => {
    textareaRef.current.value = value;
    textareaRef.current.setSelectionRange(value.length, value.length);
    return view.result.current.refreshSuggestions(value, value.length);
  };
  return { ...view, type };
}

describe("@ file mentions", () => {
  it("see files created since the last @", async () => {
    let files = ["src/a.ts"];
    const { result, type } = suggestions(async () => files);
    await act(async () => type("@"));
    expect(result.current.mentionItems).toContain("src/a.ts");
    await act(async () => type("listo"));
    files = ["src/a.ts", "src/nuevo.ts"];
    await act(async () => type("@nue"));
    expect(result.current.mentionItems).toContain("src/nuevo.ts");
  });

  it("list the chat's worktree, and the project when the worktree can't be read", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { workspace: string }) => (args.workspace === "E:/wt" ? ["wt-only.ts"] : ["project.ts"]));
    const { result } = renderHook(() => useProjectCommands("E:/ws"));
    expect(await result.current.listProjectFiles("E:/wt")).toEqual(["wt-only.ts"]);
    invoke.mockImplementation(async (_cmd: string, args: { workspace: string }) => {
      if (args.workspace === "E:/wt") throw new Error("denied");
      return ["project.ts"];
    });
    expect(await result.current.listProjectFiles("E:/wt")).toEqual(["project.ts"]);
  });
});
