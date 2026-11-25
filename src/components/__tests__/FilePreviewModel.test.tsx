// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as { cmd: string; args: unknown }[]);
vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return cmd === "agent_read_model" ? "c29saWQ=" : null;
  },
}));
// WebGL isn't in jsdom: the view itself is stood in for.
vi.mock("@/components/views/ModelView", () => ({
  default: ({ format, name, base64 }: { format: string; name: string; base64: string }) => <p>{`model ${format} ${name} ${base64}`}</p>,
}));

const { FilePreview } = await import("@/components/views/FilePreview");

afterEach(cleanup);

it("opens a 3D model in the 3D view, reading its bytes", async () => {
  render(<FilePreview path="D:/p/part.stl" label="part.stl" refreshKey={0} workspace="D:/p" />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(await screen.findByText("model stl part.stl c29saWQ=")).toBeTruthy();
  expect(calls.map((c) => c.cmd)).toEqual(["agent_read_model"]);
});
