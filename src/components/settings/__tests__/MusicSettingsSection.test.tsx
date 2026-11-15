// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@/lib/desktopOs", () => ({ desktopOs: () => "windows" }));

const { MusicSettingsSection } = await import("../MusicSettingsSection");
const { __musicForTests: store } = await import("@/lib/music/player");
const { getTranslations } = await import("@/lib/i18n");
const t = getTranslations("en-US").music;

beforeEach(() => {
  store.reset();
  localStorage.clear();
});
afterEach(cleanup);

describe("MusicSettingsSection", () => {
  it("shows each service's logo", async () => {
    const { container } = render(<MusicSettingsSection />);
    await act(async () => {});
    expect(container.querySelector('circle[fill="#f00"]')).toBeTruthy();
    expect(container.querySelector('path[fill="#1db954"]')).toBeTruthy();
  });

  it("marks YouTube Music as connected after connecting it", async () => {
    const { container } = render(<MusicSettingsSection />);
    await act(async () => {});
    expect(container.querySelector(".bg-green-500")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t.connect })); });
    expect(screen.getByText(t.connected)).toBeTruthy();
    expect(container.querySelector(".bg-green-500")).toBeTruthy();
    expect(screen.getByRole("button", { name: t.disconnect })).toBeTruthy();
  });
});
