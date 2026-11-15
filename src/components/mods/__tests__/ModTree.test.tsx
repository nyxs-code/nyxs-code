import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { makeHost } from "@/lib/mods/__tests__/harness";
import { ModTree } from "../ModTree";

/** theme-examples' card as Nyxs draws it: the bundled copy of Anthropic's plugin. */
async function cardMarkup(): Promise<string> {
  const root = path.resolve("resources/plugins/theme-examples");
  const { host } = makeHost({ mods: [{ plugin: "theme-examples", root, entry: "hooks/register.tsx", options: {}, source: "installed" }], exists: (p) => p === "/proj" });
  await host.activate("chat-1");
  await host.runCommand("chat-1", "custom-theme", "snow-pines");
  await host.runCommand("chat-1", "custom-theme", "");
  const [row] = await host.renderBand("chat-1", false);
  return renderToStaticMarkup(<ModTree tree={row.tree} onPress={() => {}} />);
}

describe("a mod's card", () => {
  it("draws theme-examples' card with a header, joined buttons and the theme in use marked", async () => {
    const html = await cardMarkup();
    // The close button is an ✕ with its label for screen readers, and nothing takes the focus.
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain("autofocus");
    expect(html).toMatch(/sticky -top-2\.5/);
    // Each theme's three buttons are one control; the one in use is filled and its row tinted.
    expect(html.match(/divide-x/g)?.length).toBe(20);
    expect(html).toMatch(/bg-accent\/10[^>]*>.*Snow Pines/);
    expect(html).toMatch(/bg-accent text-white[^>]*>Applied</);
    // A twin's note is a chip by the title, not a third line.
    expect(html).toContain("Light: Halftone Dawn");
    expect(html).not.toContain("For light windows: Halftone Dawn");
    // The plugin's own card border isn't drawn inside the band's.
    expect(html).not.toContain("rounded-[8px] border");
  }, 30_000);
});
