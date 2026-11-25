// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Clock, Search } from "lucide-react";
import { NavRows, type NavRow } from "@/components/sidebar/NavRows";
import { getTranslations } from "@/lib/i18n";
import { resetSidebarRowsCache } from "@/lib/sidebarRows";

const t = getTranslations("en-US").sidebarMenu;
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetSidebarRowsCache();
});

const rows = (openScheduled = vi.fn()): NavRow[] => [
  { id: "search", icon: Search, label: "Search", onClick: () => {} },
  { id: "routines", icon: Clock, label: "Scheduled", onClick: openScheduled },
];

describe("the sidebar's rows", () => {
  it("move to More with a right click, open from there and come back", () => {
    const openScheduled = vi.fn();
    render(<NavRows rows={rows(openScheduled)} />);
    expect(screen.queryByRole("button", { name: t.moreRows })).toBeNull();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Scheduled" }));
    fireEvent.click(screen.getByRole("menuitem", { name: t.hideRow.replace("{row}", "Scheduled") }));
    expect(screen.queryByRole("button", { name: "Scheduled" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(t.movedToMore.replace("{row}", "Scheduled"));

    fireEvent.click(screen.getByRole("button", { name: t.moreRows }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Scheduled" }));
    expect(openScheduled).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t.moreRows }));
    fireEvent.click(screen.getByRole("button", { name: t.showRow.replace("{row}", "Scheduled") }));
    expect(screen.getByRole("button", { name: "Scheduled" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.moreRows })).toBeNull();
  });

  it("stay hidden after a restart", () => {
    render(<NavRows rows={rows()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("menuitem", { name: t.hideRow.replace("{row}", "Search") }));
    cleanup();
    resetSidebarRowsCache();
    render(<NavRows rows={rows()} />);
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    expect(screen.getByRole("button", { name: t.moreRows })).toBeTruthy();
  });
});
