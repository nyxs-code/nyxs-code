import { describe, expect, it } from "vitest";
import { compileMod, type ModRef } from "../compile";
import { isElement, type RenderElement, type RenderNode } from "../types";
import { makeHost } from "./harness";

const ROOT = "/plugins/lagoon";

/** A small mod in Claude Code's format: a theme, a command, a card with buttons, state. */
const FILES: Record<string, string> = {
  [`${ROOT}/hooks/register.tsx`]: `
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import { SCENE, label } from './scene'

const picked = atom({ plugin: 'lagoon', key: 'picked' } as const, { count: 0, name: '' }, { shape: 'picked-1' })

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'lagoon', description: 'Paints the lagoon' })
    await $.theme.set({ backdrop: { scene: 'lagoon', glass: { blur: 7, opacity: 0.4 } }, overrideColorScheme: 'light' })
    $.ui.status('lagoon on ' + (await $.session.root()))
    return next(e)
  })

  on('command.run', { command: 'lagoon' }, async ($, e) => {
    if (e.args === 'off') {
      await $.theme.clear()
      return { text: 'Cleared.' }
    }
    await $.store.set('last', e.args)
    await update($, picked, was => ({ count: was.count + 1, name: e.args }))
    return { text: 'Applied ' + label(e.args) + '. greeting=' + String(options.greeting ?? '') }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.text === 'secret') return { drop: 'no secrets' }
    return next({ ...e, text: e.text.replace('lagoon', 'LAGOON') })
  })

  on('ui.render', { component: 'Backdrop' }, ($, e, next) => {
    if (e.props.plugin !== 'lagoon') return next(e)
    const { Svg } = $.ui.resolve(e)
    return <Svg source={SCENE} alt="A lagoon" isInteractive />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, picked)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap="md">
        <Text bold>{'Picked ' + now.count}</Text>
        <Button key="more" label="More" onPress={() => update($, picked, was => ({ ...was, count: was.count + 10 }))}>More</Button>
      </Box>
    )
  })
}
`,
  [`${ROOT}/hooks/scene.ts`]: `
export const SCENE: string = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
export function label(name: string): string {
  return name.toUpperCase()
}
`,
};

const REF: ModRef = { plugin: "lagoon", root: ROOT, entry: "hooks/register.tsx", options: { greeting: "hola" }, source: "installed" };

function find(node: RenderNode, el: string): RenderElement | null {
  if (!isElement(node)) return null;
  if (node.$el === el) return node;
  for (const c of node.children) {
    const f = find(c, el);
    if (f) return f;
  }
  return null;
}

const text = (node: RenderNode): string => (typeof node === "string" ? node : isElement(node) ? node.children.map(text).join("") : "");

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("mod engine", () => {
  it("compiles a hooks module and the files it imports into one script", async () => {
    const out = await compileMod(REF, async (p) => FILES[p] ?? null);
    expect(out.script).toContain('__define("hooks/register.tsx"');
    expect(out.script).toContain('__define("hooks/scene.ts"');
    expect(out.script).toContain('__boot("./hooks/register.tsx"');
    await expect(compileMod({ ...REF, entry: "hooks/missing.ts" }, async () => null)).rejects.toThrow(/not found/);
  });

  it("refuses an import that leaves the plugin's folder", async () => {
    const files: Record<string, string> = { [`${ROOT}/hooks/register.ts`]: "import { x } from '../../other/x'\nexport const register = () => x" };
    await expect(compileMod({ ...REF, entry: "hooks/register.ts" }, async (p) => files[p] ?? null)).rejects.toThrow(/outside/);
  });

  it("runs session.start: the theme stands, the command and the status are registered", async () => {
    const { host } = makeHost({ mods: [REF], files: FILES });
    await host.activate("chat-1");
    expect(host.theme("chat-1")).toMatchObject({ plugin: "lagoon", args: { overrideColorScheme: "light", backdrop: { scene: "lagoon" } } });
    expect(host.commands("chat-1").map((c) => c.name)).toEqual(["lagoon"]);
    expect(host.status("chat-1")).toEqual([{ plugin: "lagoon", text: "lagoon on /proj" }]);
  });

  it("draws the backdrop scene through the mod's Backdrop hook", async () => {
    const { host } = makeHost({ mods: [REF], files: FILES });
    await host.activate("chat-1");
    const tree = await host.renderBackdrop("chat-1");
    expect(tree && find(tree, "Svg")?.props).toMatchObject({ alt: "A lagoon", source: expect.stringContaining("<svg") });
  });

  it("runs a command with its options, keeps the store and the state, and clears the theme", async () => {
    const { host, stores } = makeHost({ mods: [REF], files: FILES });
    await host.activate("chat-1");
    expect(await host.runCommand("chat-1", "lagoon", "honu")).toBe("Applied HONU. greeting=hola");
    // The answer is a toast of the mod's, not a message in the chat.
    expect(host.toasts.at(-1)).toMatchObject({ plugin: "lagoon", text: "Applied HONU. greeting=hola" });
    expect(stores.get("lagoon")).toEqual({ last: "honu" });
    const band = await host.renderBand("chat-1", false);
    expect(text(band[0].tree)).toContain("Picked 1");
    expect(await host.runCommand("chat-1", "lagoon", "off")).toBe("Cleared.");
    expect(host.theme("chat-1")).toBeNull();
  });

  it("presses a button the mod drew, and the drawing reads the new state", async () => {
    const { host } = makeHost({ mods: [REF], files: FILES });
    await host.activate("chat-1");
    const [row] = await host.renderBand("chat-1", false);
    const fn = find(row.tree, "Button")!.props.onPress as { $fn: number };
    host.press("chat-1", "lagoon", fn.$fn);
    await waitFor(() => host.version > 0 && true);
    let again = "";
    for (let i = 0; i < 50 && !again.includes("Picked 10"); i++) {
      await new Promise((r) => setTimeout(r, 5));
      again = text((await host.renderBand("chat-1", false))[0].tree);
    }
    expect(again).toContain("Picked 10");
  });

  it("lets mods rewrite or drop a prompt", async () => {
    const { host } = makeHost({ mods: [REF], files: FILES });
    await host.activate("chat-1");
    expect(await host.submitPrompt("chat-1", "to the lagoon")).toEqual({ text: "to the LAGOON" });
    expect(await host.submitPrompt("chat-1", "secret")).toEqual({ drop: "no secrets" });
  });

  it("keeps a new session's mods when it gets its id", async () => {
    const { host, info } = makeHost({ mods: [REF], files: FILES, info: { chatId: null } });
    await host.activate("draft:/proj");
    info.chatId = "chat-9";
    host.adopt("draft:/proj", "chat-9");
    expect(host.commands("chat-9").map((c) => c.name)).toEqual(["lagoon"]);
    expect(host.commands("draft:/proj")).toEqual([]);
  });

  it("answers a TypeError for a noun Nyxs doesn't have, and refuses an unknown theme attribute", async () => {
    const files = {
      [`${ROOT}/hooks/register.ts`]: `
export const register = (on) => {
  on('command.run', { command: 'probe' }, async ($) => {
    const out = []
    try { await $.ui.backdrop({ id: 'x' }) } catch (e) { out.push(e instanceof TypeError ? 'type' : 'other') }
    try { await $.theme.set({ sparkle: true }) } catch (e) { out.push(e.message) }
    return { text: out.join('|') }
  })
  on('session.start', async ($, e, next) => { await $.command.register({ name: 'probe', description: 'p' }); return next(e) })
}`,
    };
    const { host } = makeHost({ mods: [{ ...REF, entry: "hooks/register.ts" }], files });
    await host.activate("chat-1");
    expect(await host.runCommand("chat-1", "probe", "")).toBe('type|theme.set does not know the attribute "sparkle"');
  });

  it("keeps the app's own command names from mods", async () => {
    const files = {
      [`${ROOT}/hooks/register.ts`]: `
export const register = (on) => {
  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'clear', description: 'x' }) } catch (err) { $.ui.status(err.message) }
    return next(e)
  })
}`,
    };
    const { host } = makeHost({ mods: [{ ...REF, entry: "hooks/register.ts" }], files });
    await host.activate("chat-1");
    expect(host.commands("chat-1")).toEqual([]);
    expect(host.status("chat-1")[0].text).toBe("/clear is a command of Nyxs");
  });
  it("asks before loading the mods the agent wrote, then loads them and tells the agent once", async () => {
    const dev: ModRef = { ...REF, source: "dev" };
    const { host } = makeHost({ mods: [], devMods: [dev], files: FILES });
    await host.activate("chat-1");
    expect(host.devConsentPending("chat-1")).toBe(true);
    expect(host.commands("chat-1")).toEqual([]);
    await host.answerDevConsent("chat-1", true);
    expect(host.devConsentPending("chat-1")).toBe(false);
    expect(host.commands("chat-1").map((c) => c.name)).toEqual(["lagoon"]);
    expect(host.takeNotice("chat-1")).toBe("Mods: lagoon: loaded.");
    expect(host.takeNotice("chat-1")).toBeNull();
    // Nothing changed on disk: the end of the next turn reloads nothing.
    await host.turnEnded("chat-1");
    expect(host.takeNotice("chat-1")).toBeNull();
  });

  it("loads nothing the user declined, and says so to the agent", async () => {
    const { host } = makeHost({ mods: [], devMods: [{ ...REF, source: "dev" }], files: FILES });
    await host.activate("chat-1");
    await host.answerDevConsent("chat-1", false);
    await host.turnEnded("chat-1");
    expect(host.commands("chat-1")).toEqual([]);
    expect(host.takeNotice("chat-1")).toMatch(/did not turn on/);
  });
});
