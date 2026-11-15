import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ list: [] as { cmd: string; args: unknown }[] }));
vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.list.push({ cmd, args });
    if (cmd === "remote_forward") return 5174;
    throw new Error(`unexpected ${cmd}`);
  },
}));

import { isInsideRemote, parseRemote, remoteUri, resolveRemotePath, tunnelUrl } from "@/lib/remote";
import { resolvePath } from "@/tools/paths";

describe("remote paths", () => {
  it("parses Unix and Windows machines' paths", () => {
    expect(parseRemote("ssh://vps/home/me/app/")).toEqual({ host: "vps", path: "/home/me/app" });
    expect(parseRemote("ssh://me@casa:2222/C:/code/app")).toEqual({ host: "me@casa:2222", path: "C:/code/app" });
    expect(parseRemote("ssh://vps")).toEqual({ host: "vps", path: "/" });
    expect(parseRemote("/home/me")).toBeNull();
    expect(remoteUri("casa", "C:\\code\\app")).toBe("ssh://casa/C:/code/app");
  });

  it("resolves what the agent passes against the remote project", () => {
    const ws = "ssh://vps/home/me/app";
    expect(resolveRemotePath("src/a.ts", ws)).toBe("ssh://vps/home/me/app/src/a.ts");
    expect(resolveRemotePath("/home/me/app/b.ts", ws)).toBe("ssh://vps/home/me/app/b.ts");
    expect(resolveRemotePath("ssh://vps/home/me/app/./c/../d.ts", ws)).toBe("ssh://vps/home/me/app/d.ts");
    expect(resolvePath("src\\x.ts", ws)).toBe("ssh://vps/home/me/app/src/x.ts");
  });

  it("refuses paths outside the project or on another machine", () => {
    const ws = "ssh://vps/home/me/app";
    expect(() => resolveRemotePath("../secret", ws)).toThrow(/Acceso denegado/);
    expect(() => resolveRemotePath("/etc/passwd", ws)).toThrow(/Acceso denegado/);
    expect(() => resolveRemotePath("ssh://other/home/me/app/a", ws)).toThrow(/Acceso denegado/);
    expect(isInsideRemote("ssh://vps/home/me/apple", ws)).toBe(false);
    expect(isInsideRemote("ssh://casa/c:/Code/x", "ssh://casa/C:/code")).toBe(true);
  });

  it("sends a remote project's localhost through a tunnel and leaves the rest alone", async () => {
    const ws = "ssh://vps/home/me/app";
    expect(await tunnelUrl("http://localhost:5173/a?b=1", ws)).toBe("http://localhost:5174/a?b=1");
    expect(calls.list.at(-1)).toEqual({ cmd: "remote_forward", args: { host: "vps", port: 5173 } });
    const before = calls.list.length;
    expect(await tunnelUrl("https://example.com/", ws)).toBe("https://example.com/");
    expect(await tunnelUrl("http://localhost:5173/", "E:\\code\\app")).toBe("http://localhost:5173/");
    expect(calls.list.length).toBe(before);
  });
});
