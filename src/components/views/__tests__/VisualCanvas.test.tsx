// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => null }));

const { VisualCanvas } = await import("../VisualCanvas");
const { getTranslations } = await import("@/lib/i18n");
const tr = getTranslations("en-US");

const visual = { id: "abc", src: "http://nyxspreview.localhost/__nyxs/mockup/abc", title: "Mi tarjeta" };

function mount(active = true) {
  const onPickElement = vi.fn();
  const view = render(
    <VisualCanvas visual={visual} active={active} onClose={() => {}} onToggleMaximize={() => {}} maximized={false} onPickElement={onPickElement} />,
  );
  const frame = () => screen.getByTitle(visual.title) as HTMLIFrameElement;
  return { ...view, onPickElement, frame };
}

const pickFrom = (frame: HTMLIFrameElement) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data: { source: "nyxs-pick", selector: "div.card", path: "div.card", text: "Hola", html: "<div class=\"card\">Hola</div>" }, source: frame.contentWindow }));
  });

afterEach(cleanup);

describe("VisualCanvas", () => {
  it("loads the page with the tools, in the same sandbox as the chat's", () => {
    const { frame } = mount();
    expect(frame().getAttribute("src")).toBe(`${visual.src}/canvas`);
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  });

  it("turns the page's picker on and shows the drawing tools", async () => {
    const { frame } = mount();
    const post = vi.spyOn(frame().contentWindow as Window, "postMessage");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: tr.views.selectElement })); });
    expect(post).toHaveBeenCalledWith({ type: "nyxs-pick-start" }, "*");
    // A sandboxed frame has no origin to name: naming one would drop the message.
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ source: "nyxs-agent", cmd: "annotate" }), "*");
    // The header's arrow and the one in the drawing toolbar.
    expect(screen.getAllByRole("button", { pressed: true, name: tr.views.selectElement })).toHaveLength(2);
  });

  it("hands a picked element to the chat only while the picker is on", async () => {
    const { frame, onPickElement } = mount();
    await pickFrom(frame());
    expect(onPickElement).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: tr.views.selectElement })); });
    await pickFrom(frame());
    await act(async () => {});
    expect(onPickElement).toHaveBeenCalledWith(expect.objectContaining({ selector: "div.card", text: "Hola" }));
  });

  it("leaves Ctrl+Shift+S to an open browser panel", async () => {
    mount(false);
    const button = screen.getByRole("button", { name: tr.views.selectElement });
    await act(async () => { fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true }); });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("opens the picker with Ctrl+Shift+S when the shortcut is its own", async () => {
    mount(true);
    const button = screen.getByRole("button", { name: tr.views.selectElement });
    await act(async () => { fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true }); });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the visual at the size chosen in the menu", async () => {
    const { frame } = mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: tr.inlinePreview.more })); });
    await act(async () => { fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(tr.views.viewportMobile) })); });
    expect((frame().parentElement as HTMLElement).style.width).toBe("375px");
  });
});
