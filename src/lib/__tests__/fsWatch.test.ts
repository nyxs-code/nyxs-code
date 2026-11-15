import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();
const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: Handler) => {
    handlers.set(event, cb);
    return () => {};
  }),
}));
vi.mock("@/lib/ipc", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const { subscribeFsChange, subscribeGitChange } = await import("../fsWatch");

/** Lets the queued start/stop calls run. */
const settle = () => vi.advanceTimersByTimeAsync(0);
/** What the backend sends: the event and the root it is about. */
const fire = (event: string, root: string) => handlers.get(event)?.({ payload: root });

describe("fsWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    invoke.mockImplementation(async () => undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("shares one watcher per root and keeps git changes apart from file changes", async () => {
    const onFiles = vi.fn();
    const onGit = vi.fn();
    const offFiles = subscribeFsChange("D:\\app", onFiles);
    const offGit = subscribeGitChange("D:\\app", onGit);
    await settle();
    expect(invoke.mock.calls).toEqual([["fs_watch_start", { path: "D:\\app" }]]);

    fire("git-change", "D:\\app");
    fire("git-change", "D:\\app");
    await vi.advanceTimersByTimeAsync(250);
    expect(onGit).toHaveBeenCalledTimes(1);
    expect(onFiles).not.toHaveBeenCalled();

    fire("fs-change", "D:\\app");
    await vi.advanceTimersByTimeAsync(250);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onGit).toHaveBeenCalledTimes(1);

    offFiles();
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
    offGit();
    await settle();
    expect(invoke).toHaveBeenLastCalledWith("fs_watch_stop", { path: "D:\\app" });
  });

  it("keeps the project on screen watched while a chat in the background watches another", async () => {
    const onScreen = vi.fn();
    const background = vi.fn();
    const offScreen = subscribeFsChange("D:\\app", onScreen);
    const offBackground = subscribeFsChange("E:\\other", background);
    await settle();
    expect(invoke.mock.calls).toEqual([
      ["fs_watch_start", { path: "D:\\app" }],
      ["fs_watch_start", { path: "E:\\other" }],
    ]);

    // Each change reaches only the subscribers of its root, however the root is spelled.
    fire("fs-change", "d:/app/");
    await vi.advanceTimersByTimeAsync(250);
    expect(onScreen).toHaveBeenCalledTimes(1);
    expect(background).not.toHaveBeenCalled();
    fire("fs-change", "E:\\other");
    await vi.advanceTimersByTimeAsync(250);
    expect(background).toHaveBeenCalledTimes(1);
    expect(onScreen).toHaveBeenCalledTimes(1);

    // The background chat leaving stops only its own watcher.
    offBackground();
    await settle();
    expect(invoke).toHaveBeenLastCalledWith("fs_watch_stop", { path: "E:\\other" });
    fire("fs-change", "D:\\app");
    await vi.advanceTimersByTimeAsync(250);
    expect(onScreen).toHaveBeenCalledTimes(2);
    offScreen();
    await settle();
  });

  it("tries again later when the watcher couldn't start", async () => {
    invoke.mockImplementationOnce(async () => {
      throw new Error("inotify is out of watches");
    });
    const off = subscribeFsChange("/home/me/app", vi.fn());
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
    // Not taken as watching: a second subscriber or the timer starts it again.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(invoke.mock.calls).toEqual([
      ["fs_watch_start", { path: "/home/me/app" }],
      ["fs_watch_start", { path: "/home/me/app" }],
    ]);
    off();
    await settle();
    expect(invoke).toHaveBeenLastCalledWith("fs_watch_stop", { path: "/home/me/app" });
    // Nothing is retried for a root nobody watches any more.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
