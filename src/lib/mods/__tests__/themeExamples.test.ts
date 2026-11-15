import path from "node:path";
import { describe, expect, it } from "vitest";
import { isElement, type RenderElement, type RenderNode, type StandingTheme } from "../types";
import { makeHost } from "./harness";

/**
 * Anthropic's own theme-examples plugin (claude-plugins-official), run unchanged through Nyxs'
 * engine: the check that Nyxs answers what a real mod of Claude Code expects. Nyxs ships it
 * (`resources/plugins/`); `NYXS_THEME_EXAMPLES_DIR` points the test at another copy, such as a
 * newer one from the marketplace.
 */
const DIR = process.env.NYXS_THEME_EXAMPLES_DIR ?? path.resolve("resources/plugins/theme-examples");

function find(node: RenderNode | null, el: string, where: (e: RenderElement) => boolean = () => true): RenderElement | null {
  if (!node || !isElement(node)) return null;
  if (node.$el === el && where(node)) return node;
  for (const c of node.children) {
    const f = find(c, el, where);
    if (f) return f;
  }
  return null;
}

const sceneOf = (t: StandingTheme | null) => (t?.args.backdrop ? t.args.backdrop.scene : undefined);

describe("theme-examples, the official plugin", () => {
  const mod = () => ({ plugin: "theme-examples", root: DIR, entry: "hooks/register.tsx", options: {}, source: "installed" as const });

  it("lists its themes, applies one to the project and draws its scene", async () => {
    const { host, stores } = makeHost({ mods: [mod()], exists: (p) => p === "/proj" });
    await host.activate("chat-1");
    expect(host.commands("chat-1").map((c) => c.name).sort()).toEqual(["custom-theme", "fireworks"]);

    const list = await host.runCommand("chat-1", "custom-theme", "list");
    expect(list).toContain("honu-lagoon");

    const applied = await host.runCommand("chat-1", "custom-theme", "Honu Lagoon");
    expect(applied).toMatch(/^Honu Lagoon applied to this project/);
    expect(host.theme("chat-1")?.args).toMatchObject({ backdrop: { scene: "honu-lagoon", glass: { blur: 7 } }, overrideColorScheme: "light" });
    expect(Object.values(stores.get("theme-examples") ?? {})).toContain("honu-lagoon");

    const scene = find(await host.renderBackdrop("chat-1"), "Svg");
    expect(String(scene?.props.source)).toMatch(/^<svg/);
    expect(String(scene?.props.source).length).toBeLessThanOrEqual(131_072);
  }, 30_000);

  it("shows its card above the prompt, and a press on the card applies a theme", async () => {
    const { host } = makeHost({ mods: [mod()], exists: (p) => p === "/proj" });
    await host.activate("chat-1");
    expect(await host.runCommand("chat-1", "custom-theme", "")).toBe("Pick a theme on the card.");
    const [row] = await host.renderBand("chat-1", false);
    const apply = find(row.tree, "Button", (b) => b.props.key === "apply-night-reef");
    expect(apply).not.toBeNull();
    host.press("chat-1", "theme-examples", (apply!.props.onPress as { $fn: number }).$fn);
    for (let i = 0; i < 100 && sceneOf(host.theme("chat-1")) !== "night-reef"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sceneOf(host.theme("chat-1"))).toBe("night-reef");
    // A pick puts the card away.
    for (let i = 0; i < 100 && (await host.renderBand("chat-1", false)).length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await host.renderBand("chat-1", false)).toEqual([]);
  }, 30_000);

  // Nyxs keeps sessions open side by side; Claude Code only reads the project's choice at a session's start and at a turn.
  const twoSessions = () => makeHost({ mods: [mod()], exists: (p) => p === "/proj", infoFor: (key) => ({ chatId: key.startsWith("draft:") ? null : key }) });

  it("shows the project's new theme in a session that was already open, without a message", async () => {
    const { host } = twoSessions();
    await host.activate("chat-1");
    await host.activate("chat-2");
    await host.runCommand("chat-2", "custom-theme", "night-reef");
    expect(sceneOf(host.theme("chat-1"))).toBeUndefined();

    await host.activate("chat-1");
    expect(sceneOf(host.theme("chat-1"))).toBe("night-reef");

    // A session's own choice stays its own.
    await host.runCommand("chat-1", "custom-theme", "koi-mosaic session");
    await host.activate("chat-2");
    expect(sceneOf(host.theme("chat-2"))).toBe("night-reef");
    await host.activate("chat-1");
    expect(sceneOf(host.theme("chat-1"))).toBe("koi-mosaic");
  }, 30_000);

  it("drops a preview left in a session that starts again", async () => {
    const { host } = twoSessions();
    await host.activate("chat-2");
    await host.activate("chat-1");
    await host.runCommand("chat-1", "custom-theme", "");
    const [row] = await host.renderBand("chat-1", false);
    const preview = find(row.tree, "Button", (b) => b.props.key === "preview-honu-lagoon");
    host.press("chat-1", "theme-examples", (preview!.props.onPress as { $fn: number }).$fn);
    for (let i = 0; i < 100 && sceneOf(host.theme("chat-1")) !== "honu-lagoon"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sceneOf(host.theme("chat-1"))).toBe("honu-lagoon");

    await host.activate("chat-2");
    await host.runCommand("chat-2", "custom-theme", "night-reef");
    await host.activate("chat-1");
    expect(sceneOf(host.theme("chat-1"))).toBe("night-reef");
  }, 30_000);

  it("ends a preview when the card is closed without a pick (Nyxs' change)", async () => {
    const { host } = makeHost({ mods: [mod()], exists: (p) => p === "/proj" });
    await host.activate("chat-1");
    await host.runCommand("chat-1", "custom-theme", "night-reef");
    await host.runCommand("chat-1", "custom-theme", "");
    const press = async (key: string) => {
      const [row] = await host.renderBand("chat-1", false);
      const button = find(row.tree, "Button", (b) => b.props.key === key);
      host.press("chat-1", "theme-examples", (button!.props.onPress as { $fn: number }).$fn);
    };
    await press("preview-honu-lagoon");
    for (let i = 0; i < 100 && sceneOf(host.theme("chat-1")) !== "honu-lagoon"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sceneOf(host.theme("chat-1"))).toBe("honu-lagoon");

    await press("close");
    for (let i = 0; i < 100 && sceneOf(host.theme("chat-1")) !== "night-reef"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sceneOf(host.theme("chat-1"))).toBe("night-reef");
    expect(await host.renderBand("chat-1", false)).toEqual([]);
  }, 30_000);

  it("keeps a new session's own choice out of the next new session", async () => {
    const { host } = twoSessions();
    await host.activate("draft:/proj");
    await host.runCommand("draft:/proj", "custom-theme", "koi-mosaic session");
    host.adopt("draft:/proj", "chat-1");
    await host.activate("draft:/proj");
    expect(host.theme("draft:/proj")).toBeNull();
  }, 30_000);

  it("brings the project's theme back in a new session, and clears it", async () => {
    const h1 = makeHost({ mods: [mod()], exists: (p) => p === "/proj" });
    await h1.host.activate("chat-1");
    await h1.host.runCommand("chat-1", "custom-theme", "koi-mosaic");
    const kept = h1.stores.get("theme-examples");

    const h2 = makeHost({ mods: [mod()], exists: (p) => p === "/proj", info: { chatId: "chat-2" } });
    h2.stores.set("theme-examples", kept!);
    await h2.host.activate("chat-2");
    expect(sceneOf(h2.host.theme("chat-2"))).toBe("koi-mosaic");
    expect(await h2.host.runCommand("chat-2", "custom-theme", "off")).toMatch(/^Theme cleared for this project/);
    expect(h2.host.theme("chat-2")).toBeNull();
  }, 30_000);
});
