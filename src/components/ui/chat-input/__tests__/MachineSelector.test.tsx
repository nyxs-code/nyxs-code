// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const backend = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  folders: {} as Record<string, string[]>,
}));
vi.mock("@/lib/ipc", () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    backend.calls.push({ cmd, args });
    switch (cmd) {
      case "remote_config_hosts":
        return ["vps"];
      case "remote_connect":
        if (args.host === "nope") throw new Error("The machine didn't answer.");
        return { version: "1", protocol: 1, os: "linux", arch: "x86_64", home: "/home/me", shell: "bash", hostname: "vps", user: "me" };
      case "remote_home":
        return `ssh://${String(args.host)}/home/me`;
      case "remote_create_folder": {
        if (String(args.name) === "app") throw new Error("app already exists here.");
        const made = `${String(args.parent)}/${String(args.name)}`;
        backend.folders[made] = [];
        return made;
      }
      case "remote_list_folders":
        return backend.folders[String(args.path)] ?? [];
      default:
        return null;
    }
  },
}));

import { WorkspaceChips } from "@/components/ui/chat-input/WorkspaceChips";
import { saveMachine } from "@/lib/remote";

afterEach(cleanup);
beforeEach(() => {
  backend.calls = [];
  backend.folders = { "ssh://vps/home/me": ["app", ".config"], "ssh://vps/home/me/app": [] };
  localStorage.clear();
});

const settle = () => act(async () => {});

describe("WorkspaceChips with remote machines", () => {
  it("adds a machine, connects and opens the folder picked on it", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<WorkspaceChips workspace="E:\\code\\local" recentWorkspaces={["E:\\code\\local"]} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /Local/ }));
    await user.click(screen.getByText("Add SSH machine…"));
    await settle();
    // The hosts of ~/.ssh/config are offered.
    await user.click(await screen.findByRole("button", { name: "vps" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await settle();

    // Connected: the machine's folder picker opens in its home.
    expect(await screen.findByText("/home/me")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "app" }));
    expect(await screen.findByText("/home/me/app")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open this folder" }));
    expect(onSelect).toHaveBeenCalledWith("ssh://vps/home/me/app");
    expect(JSON.parse(localStorage.getItem("nyxs.remoteMachines.v1") ?? "[]")).toEqual([{ host: "vps" }]);
  });

  it("shows why a machine couldn't be reached and saves nothing", async () => {
    const user = userEvent.setup();
    render(<WorkspaceChips workspace={null} recentWorkspaces={[]} />);
    await user.click(screen.getByRole("button", { name: /Local/ }));
    await user.click(screen.getByText("Add SSH machine…"));
    await settle();
    await user.type(screen.getByPlaceholderText(/user@server/), "nope");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("The machine didn't answer.")).toBeTruthy();
    expect(localStorage.getItem("nyxs.remoteMachines.v1")).toBeNull();
  });

  it("lists only the chosen machine's folders and goes back to this computer's", async () => {
    saveMachine({ host: "vps", name: "VPS" });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <WorkspaceChips
        workspace="ssh://vps/home/me/app"
        recentWorkspaces={["ssh://vps/home/me/app", "E:\\code\\local", "ssh://casa/C:/x"]}
        onSelect={onSelect}
      />,
    );
    // The machine chip names the machine; the folder chip lists its folders only.
    await user.click(screen.getByRole("button", { name: "app" }));
    expect(screen.queryByText("local")).toBeNull();
    expect(screen.queryByText("x")).toBeNull();
    await user.click(screen.getByRole("button", { name: /VPS/ }));
    await user.click(screen.getByText("This computer"));
    expect(onSelect).toHaveBeenCalledWith("E:\\code\\local");
  });

  it("makes a new folder on the machine and opens it", async () => {
    saveMachine({ host: "vps" });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<WorkspaceChips workspace="E:\code\local" recentWorkspaces={[]} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /Local/ }));
    await user.click(screen.getByRole("button", { name: /vps/ }));
    await settle();
    await screen.findByText("/home/me");

    // A name that is taken says so and keeps the field.
    await user.click(screen.getByRole("button", { name: "New folder" }));
    await user.type(screen.getByLabelText("Folder name"), "app{Enter}");
    expect(await screen.findByText("app already exists here.")).toBeTruthy();

    await user.clear(screen.getByLabelText("Folder name"));
    await user.type(screen.getByLabelText("Folder name"), "nuevo-proyecto{Enter}");
    expect(await screen.findByText("/home/me/nuevo-proyecto")).toBeTruthy();
    expect(backend.calls.some((c) => c.cmd === "remote_create_folder" && c.args.name === "nuevo-proyecto")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Open this folder" }));
    expect(onSelect).toHaveBeenCalledWith("ssh://vps/home/me/nuevo-proyecto");
  });

  it("Escape drops the new folder's name without closing the picker", async () => {
    saveMachine({ host: "vps" });
    const user = userEvent.setup();
    render(<WorkspaceChips workspace={null} recentWorkspaces={[]} />);
    await user.click(screen.getByRole("button", { name: /Local/ }));
    await user.click(screen.getByRole("button", { name: /vps/ }));
    await settle();
    await screen.findByText("/home/me");
    await user.click(screen.getByRole("button", { name: "New folder" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Folder name")).toBeNull();
    expect(screen.getByText("/home/me")).toBeTruthy();
  });
});
