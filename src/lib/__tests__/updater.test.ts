import { describe, it, expect, vi, beforeEach } from "vitest";

const fake = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  calls: [] as string[],
}));

vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: () => {}, removeEventListener: () => {} });
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => fake.check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => fake.relaunch() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    fake.calls.push(cmd);
  },
}));

const { __updaterForTests: store } = await import("@/lib/updater");

const update = (version: string) => ({
  version,
  body: "notes",
  download: vi.fn(async () => { fake.calls.push("download"); }),
  install: vi.fn(async () => { fake.calls.push("install"); }),
});

beforeEach(() => {
  store.reset();
  fake.check.mockReset();
  fake.relaunch.mockReset();
  fake.calls = [];
});

describe("updater", () => {
  it("finds a version published while the app is open", async () => {
    fake.check.mockResolvedValue(null);
    expect(await store.check()).toBe(false);
    expect(store.get().status).toBe("idle");

    fake.check.mockResolvedValue(update("0.9.0"));
    expect(await store.check()).toBe(true);
    expect(store.get()).toMatchObject({ status: "available", version: "0.9.0", checking: false });
  });

  it("shares one check between callers that ask at the same time", async () => {
    fake.check.mockResolvedValue(update("0.9.0"));
    await Promise.all([store.check(), store.check(), store.check()]);
    expect(fake.check).toHaveBeenCalledTimes(1);
  });

  it("keeps a found version when a later check fails", async () => {
    fake.check.mockResolvedValue(update("0.9.0"));
    await store.check();
    fake.check.mockRejectedValue(new Error("offline"));
    expect(await store.check()).toBe(true);
    expect(store.get()).toMatchObject({ status: "available", version: "0.9.0" });
  });

  it("tells a failed check apart from there being nothing new", async () => {
    fake.check.mockRejectedValue(new Error("offline"));
    expect(await store.check()).toBe(false);
    expect(store.get()).toMatchObject({ status: "idle", checkFailed: true });

    fake.check.mockResolvedValue(null);
    await store.check();
    expect(store.get()).toMatchObject({ status: "idle", checkFailed: false });
  });

  it("stops the app's processes between the download and the install", async () => {
    fake.check.mockResolvedValue(update("0.9.0"));
    await store.check();
    await store.install();
    expect(fake.calls).toEqual(["save_window_state", "download", "nyxs_prepare_update", "install"]);
    expect(fake.relaunch).toHaveBeenCalledTimes(1);
  });

  it("logs an install that failed once the app's processes were stopped, and stays usable", async () => {
    const failing = { ...update("0.9.0"), install: vi.fn(async () => { throw new Error("signature mismatch"); }) };
    fake.check.mockResolvedValue(failing);
    await store.check();
    await store.install();
    expect(fake.calls).toEqual(["save_window_state", "download", "nyxs_prepare_update", "nyxs_update_install_failed"]);
    expect(fake.relaunch).not.toHaveBeenCalled();
    expect(store.get().status).toBe("error");
  });

  it("doesn't call it that when the download failed before anything was stopped", async () => {
    const failing = { ...update("0.9.0"), download: vi.fn(async () => { throw new Error("offline"); }) };
    fake.check.mockResolvedValue(failing);
    await store.check();
    await store.install();
    expect(fake.calls).toEqual(["save_window_state"]);
    expect(store.get().status).toBe("error");
  });

  it("doesn't check while an update is installing", async () => {
    store.patch({ status: "downloading" });
    await store.check();
    expect(fake.check).not.toHaveBeenCalled();
  });
});
