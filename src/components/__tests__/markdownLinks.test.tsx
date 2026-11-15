// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ opened: [] as string[], external: [] as string[] }));

vi.mock("@/lib/filePaths", async (orig) => ({
  ...(await orig<object>()),
  currentWorkspace: () => "E:/proj",
  pathKind: async () => "file",
  openPathRef: (ref: { abs: string }) => fake.opened.push(ref.abs),
}));
vi.mock("@/lib/openExternal", () => ({ openChatLink: (url: string) => fake.external.push(url) }));

import { MarkdownText } from "@/components/message/markdown";

afterEach(() => {
  cleanup();
  fake.opened = [];
  fake.external = [];
});

describe("links in a message", () => {
  it("open a project file when they point at one", async () => {
    render(<MarkdownText text="Mira [App.tsx](src/App.tsx) y [la línea](src/main.tsx#L35)." />);
    await act(async () => {
      fireEvent.click(screen.getByText("App.tsx"));
      fireEvent.click(screen.getByText("la línea"));
    });
    expect(fake.opened).toEqual(["E:/proj/src/App.tsx", "E:/proj/src/main.tsx"]);
    expect(fake.external).toEqual([]);
  });

  it("open a web address, written as a link or bare", () => {
    render(<MarkdownText text="[Docs](https://example.com/docs) o https://example.com/raw." />);
    fireEvent.click(screen.getByText("Docs"));
    fireEvent.click(screen.getByText("https://example.com/raw"));
    expect(fake.external).toEqual(["https://example.com/docs", "https://example.com/raw"]);
  });
});
