// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";

/** The settings, as the editor writes them: `update` merges like settingsRuntime does. */
const store = vi.hoisted(() => {
  let settings: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      const av = out[k];
      out[k] = av && v && typeof av === "object" && typeof v === "object" ? merge(av as Record<string, unknown>, v as Record<string, unknown>) : v;
    }
    return out;
  };
  return {
    get: () => settings,
    set: (next: Record<string, unknown>) => {
      settings = next;
      listeners.forEach((l) => l());
    },
    update: async (partial: Record<string, unknown>) => {
      settings = merge(settings, partial);
      listeners.forEach((l) => l());
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
});

vi.mock("@/lib/settingsRuntime", () => ({ getMergedSnapshot: store.get, subscribeSettings: store.subscribe }));
vi.mock("@/lib/useSettings", () => ({
  useSettings: () => ({ settings: useSyncExternalStore(store.subscribe, store.get), update: store.update }),
}));

const { ShortcutsModal } = await import("@/components/ShortcutsModal");
const { currentBindings, isRecordingShortcut } = await import("@/lib/keyBindings");
const { getTranslations } = await import("@/lib/i18n");
const t = getTranslations("en-US").shortcutsModal;

beforeEach(() => store.set({}));
afterEach(cleanup);

async function open() {
  const onClose = vi.fn();
  render(<ShortcutsModal open onClose={onClose} />);
  await act(async () => {});
  return onClose;
}

const pencil = (name: string) => screen.getByRole("button", { name: t.changeFor.replace("{name}", name) });

describe("changing a shortcut", () => {
  it("records the keys pressed and saves them in the user's settings", async () => {
    await open();
    const p = pencil(t.toggleDiff);
    fireEvent.click(p);
    expect(isRecordingShortcut()).toBe(true);
    expect(screen.getByText(t.pressShortcut)).toBeTruthy();
    fireEvent.keyDown(p, { key: "Control", code: "ControlLeft", ctrlKey: true });
    fireEvent.keyDown(p, { key: "G", code: "KeyG", ctrlKey: true, shiftKey: true });
    await act(async () => {});
    expect(store.get().shortcuts).toEqual({ toggleDiff: "Ctrl+Shift+G" });
    expect(currentBindings().toggleDiff).toBe("Ctrl+Shift+G");
    expect(isRecordingShortcut()).toBe(false);
    // Changed: it can go back to its default.
    fireEvent.click(screen.getByRole("button", { name: t.resetOne.replace("{name}", t.toggleDiff) }));
    await act(async () => {});
    expect(currentBindings().toggleDiff).toBe("Ctrl+Shift+D");
  });

  it("asks before taking keys another shortcut uses, and leaves that one without", async () => {
    await open();
    const p = pencil(t.toggleDiff);
    fireEvent.click(p);
    fireEvent.keyDown(p, { key: "k", code: "KeyK", ctrlKey: true });
    await act(async () => {});
    expect(store.get().shortcuts).toBeUndefined();
    expect(screen.getByText(t.alsoUsedBy.replace("{name}", getTranslations("en-US").search.sessionsTitle))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.replace }));
    await act(async () => {});
    expect(store.get().shortcuts).toEqual({ toggleDiff: "Ctrl+K", searchSessions: null });
  });

  it("refuses reserved keys and keys without Ctrl, and Escape cancels without closing the list", async () => {
    const onClose = await open();
    const p = pencil(t.newSession);
    fireEvent.click(p);
    fireEvent.keyDown(p, { key: "c", code: "KeyC", ctrlKey: true });
    expect(screen.getByText(t.reserved)).toBeTruthy();
    fireEvent.keyDown(p, { key: "g", code: "KeyG" });
    expect(screen.getByText(t.needsModifier)).toBeTruthy();
    fireEvent.keyDown(p, { key: "Escape", code: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(isRecordingShortcut()).toBe(false);
    expect(store.get().shortcuts).toBeUndefined();
  });

  it("removes a shortcut with Backspace", async () => {
    await open();
    const p = pencil(t.toggleSidebar);
    fireEvent.click(p);
    fireEvent.keyDown(p, { key: "Backspace", code: "Backspace" });
    await act(async () => {});
    expect(store.get().shortcuts).toEqual({ toggleSidebar: null });
    expect(screen.getAllByText(t.noShortcut).length).toBeGreaterThan(0);
  });

  it("resets every shortcut after asking", async () => {
    store.set({ shortcuts: { toggleDiff: "Ctrl+Shift+G", newSession: null } });
    await open();
    fireEvent.click(screen.getByRole("button", { name: t.resetAll }));
    await act(async () => {});
    expect(screen.getByText(t.resetAllTitle)).toBeTruthy();
    const confirm = screen.getAllByRole("button", { name: t.resetAll }).at(-1)!;
    fireEvent.click(confirm);
    await act(async () => {});
    expect(currentBindings().toggleDiff).toBe("Ctrl+Shift+D");
    expect(currentBindings().newSession).toBe("Ctrl+N");
  });

  it("filters the list by name or keys", async () => {
    await open();
    fireEvent.change(screen.getByRole("searchbox", { name: t.search }), { target: { value: "zzz" } });
    expect(screen.getByText(t.noMatches)).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: t.search }), { target: { value: t.toggleDiff } });
    expect(pencil(t.toggleDiff)).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.changeFor.replace("{name}", t.newSession) })).toBeNull();
  });
});
