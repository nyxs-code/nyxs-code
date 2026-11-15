// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const fake = vi.hoisted(() => ({
  version: vi.fn(async (): Promise<string> => "0.8.44"),
  tauriVersion: vi.fn(async (): Promise<string> => "2.11.2"),
  check: vi.fn(async (): Promise<unknown> => null),
  relaunch: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => fake.version(),
  getTauriVersion: () => fake.tauriVersion(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => fake.check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => fake.relaunch() }));
vi.mock("@/lib/ipc", () => ({ invoke: async () => undefined }));

// The updater decides once, on load, whether it is inside the desktop app.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

const { AboutPage } = await import("../AboutPage");
const { __updaterForTests: store } = await import("@/lib/updater");
const { getTranslations } = await import("@/lib/i18n");
const tr = getTranslations("en-US");
const a = tr.settings.aboutPage;

const mount = (props: { onWhatsNew?: () => void } = {}) => act(async () => { render(<AboutPage {...props} />); });
const press = (name: string) => act(async () => { fireEvent.click(screen.getByRole("button", { name })); });

beforeEach(() => {
  store.reset();
  fake.version.mockReset().mockResolvedValue("0.8.44");
  fake.tauriVersion.mockReset().mockResolvedValue("2.11.2");
  fake.check.mockReset().mockResolvedValue(null);
  fake.relaunch.mockClear();
});
afterEach(cleanup);

describe("AboutPage", () => {
  it("shows the installed version and stays quiet until asked", async () => {
    await mount();
    expect(screen.getByText(a.version.replace("{version}", "0.8.44"))).toBeTruthy();
    expect(screen.queryByText(a.upToDate)).toBeNull();
  });

  it("says the version is the latest after a check finds nothing", async () => {
    await mount();
    await press(a.checkUpdates);
    expect(fake.check).toHaveBeenCalledTimes(2);
    expect(screen.getByText(a.upToDate)).toBeTruthy();
  });

  it("doesn't call the version the latest when the check failed", async () => {
    await mount();
    fake.check.mockRejectedValue(new Error("offline"));
    await press(a.checkUpdates);
    expect(screen.getByText(a.checkFailed)).toBeTruthy();
    expect(screen.queryByText(a.upToDate)).toBeNull();
  });

  it("installs a version the check found", async () => {
    const download = vi.fn(async () => {});
    const install = vi.fn(async () => {});
    await mount();
    fake.check.mockResolvedValue({ version: "0.9.0", body: "", download, install });
    await press(a.checkUpdates);
    expect(screen.getByText(tr.update.newVersionAvailable.replace("{version}", " (0.9.0)"))).toBeTruthy();
    await press(tr.update.installAndRestart);
    expect(download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(fake.relaunch).toHaveBeenCalledTimes(1);
  });

  it("opens what's new from its updates row", async () => {
    const onWhatsNew = vi.fn();
    await mount({ onWhatsNew });
    await press(tr.changelog.whatsNew);
    expect(onWhatsNew).toHaveBeenCalledTimes(1);
  });

  it("reports the core as connected once the backend answers", async () => {
    await mount();
    expect(screen.getByText(a.coreConnected)).toBeTruthy();
  });

  it("shows the technical details on request, with the Tauri version", async () => {
    await mount();
    expect(screen.queryByText("2.11.2")).toBeNull();
    await press(a.technical);
    expect(screen.getByText("2.11.2")).toBeTruthy();
  });

  it("shows nothing when there is no installed version to read", async () => {
    fake.version.mockRejectedValue(new Error("not in the desktop app"));
    const { container } = render(<AboutPage />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });
});
