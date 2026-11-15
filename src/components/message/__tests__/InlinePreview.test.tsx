// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async (_cmd: string, args: { html: string }) => `id-${args.html}`) }));
vi.mock("@/lib/visualTheme", () => ({ visualThemeCss: async () => "" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => null }));
vi.mock("../markdown", () => ({ Highlighted: () => null }));

const { InlinePreview } = await import("../InlinePreview");
const { setPanelVisual, usePanelVisual } = await import("@/lib/visualPanel");

function PanelProbe() {
  return <output data-testid="panel">{usePanelVisual()?.id ?? "none"}</output>;
}
const panel = () => screen.getByTestId("panel").textContent;

const OPEN = { id: "old", src: "http://x/old", title: "Antes" };

afterEach(() => {
  cleanup();
  setPanelVisual(null);
});

describe("InlinePreview in the panel", () => {
  it("takes the panel when the agent finishes writing a new visual", async () => {
    setPanelVisual(OPEN);
    const { rerender } = render(<><PanelProbe /><InlinePreview html="nuevo" closed={false} /></>);
    expect(panel()).toBe("old");
    await act(async () => { rerender(<><PanelProbe /><InlinePreview html="nuevo" closed /></>); });
    expect(panel()).toBe("id-nuevo");
  });

  it("leaves the panel alone when a chat is read again", async () => {
    setPanelVisual(OPEN);
    await act(async () => { render(<><PanelProbe /><InlinePreview html="viejo" closed /></>); });
    expect(panel()).toBe("old");
  });

  it("doesn't open the panel when it was closed", async () => {
    const { rerender } = render(<><PanelProbe /><InlinePreview html="nuevo" closed={false} /></>);
    await act(async () => { rerender(<><PanelProbe /><InlinePreview html="nuevo" closed /></>); });
    expect(panel()).toBe("none");
  });
});
