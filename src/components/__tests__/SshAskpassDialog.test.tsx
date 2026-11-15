// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  }),
}));
const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined);
vi.mock("@/lib/ipc", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const { SshAskpassDialog } = await import("../SshAskpassDialog");

const ask = async (payload: Record<string, unknown>) => {
  await act(async () => {
    handlers.get("ssh-askpass")?.({ payload: { id: 1, host: "vps", prompt: "dev@vps's password:", kind: "password", retry: false, ...payload } });
  });
  // The dialog shows after a microtask.
  await act(async () => {});
};

describe("SshAskpassDialog", () => {
  beforeEach(() => {
    invoke.mockClear();
    handlers.clear();
  });

  it("asks for the password and hands it to ssh, remembered only when ticked", async () => {
    render(<SshAskpassDialog />);
    await act(async () => {});
    await ask({});
    expect(screen.getByRole("dialog", { name: "Sign in to vps" })).toBeTruthy();
    expect(screen.getByText("dev@vps's password:")).toBeTruthy();
    const field = screen.getByLabelText("Password");
    expect((field as HTMLInputElement).type).toBe("password");
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field, { target: { value: "s3cret" } });
    fireEvent.click(screen.getByLabelText(/Remember on this computer/));
    fireEvent.submit(field.closest("form")!);
    expect(invoke).toHaveBeenCalledWith("ssh_askpass_answer", { id: 1, value: "s3cret", remember: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says the last answer was wrong, and cancelling answers nothing", async () => {
    render(<SshAskpassDialog />);
    await act(async () => {});
    await ask({ id: 2, kind: "passphrase", prompt: "Enter passphrase for key '/home/me/.ssh/id':", retry: true });
    expect(screen.getByRole("dialog", { name: "Unlock your SSH key" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("wasn't accepted");
    expect(screen.getByLabelText("Passphrase")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invoke).toHaveBeenCalledWith("ssh_askpass_answer", { id: 2, value: null, remember: false });
  });

  it("answers a yes/no question, one question at a time", async () => {
    render(<SshAskpassDialog />);
    await act(async () => {});
    await ask({ id: 3, kind: "confirm", prompt: "Allow use of key id_ed25519?" });
    await ask({ id: 4 });
    expect(screen.getByRole("alertdialog", { name: "vps asks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(invoke).toHaveBeenCalledWith("ssh_askpass_answer", { id: 3, value: "yes", remember: false });
    await act(async () => {});
    // The next one in line.
    expect(screen.getByRole("dialog", { name: "Sign in to vps" })).toBeTruthy();
    // ssh gave up meanwhile: its dialog goes.
    await act(async () => { handlers.get("ssh-askpass-closed")?.({ payload: 4 }); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
