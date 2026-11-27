// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/openExternal", () => ({ openExternalUrl: (url: string) => opened.push(url) }));

const { CloudInfoPopover } = await import("../CloudInfoPopover");

afterEach(() => {
  cleanup();
  opened.length = 0;
  vi.useRealTimers();
});

describe("the cloud link on the empty Projects page", () => {
  it("shows what cloud threads need on hover, and the docs open from it", () => {
    render(<CloudInfoPopover>en la nube</CloudInfoPopover>);
    const link = screen.getByRole("button", { name: "en la nube" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.mouseEnter(link.parentElement!);
    const card = screen.getByRole("dialog");
    expect(link.getAttribute("aria-expanded")).toBe("true");
    expect(card.querySelectorAll("li")).toHaveLength(3);
    fireEvent.click(screen.getAllByRole("button").at(-1)!);
    expect(opened).toEqual(["https://nyxs.dev/docs/cloud"]);
  });

  it("stays open while the pointer goes over to the card, and closes after it leaves", () => {
    vi.useFakeTimers();
    render(<CloudInfoPopover>en la nube</CloudInfoPopover>);
    const wrap = screen.getByRole("button", { name: "en la nube" }).parentElement!;
    fireEvent.mouseEnter(wrap);
    fireEvent.mouseLeave(wrap);
    fireEvent.mouseEnter(wrap);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.mouseLeave(wrap);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on keyboard focus and on click, and Escape closes it", () => {
    render(<CloudInfoPopover>en la nube</CloudInfoPopover>);
    const link = screen.getByRole("button", { name: "en la nube" });
    fireEvent.focus(link);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(link);
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
});
