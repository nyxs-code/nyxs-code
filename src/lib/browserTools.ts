import { invoke } from "@/lib/ipc";
import { tunnelUrl } from "@/lib/remote";
import { ensurePreview, hasActivePreview, previewForAddress, previewWorkspace, showAgentTab, type PreviewController } from "@/lib/previewControl";

// The agent's control of the built-in browser (the Preview view). One set of definitions
// serves both the built-in models (src/tools/Browser) and Claude Code, which reaches them
// through an MCP server Nyxs hosts itself (src/lib/browserMcp.ts).

export interface BrowserToolResult {
  text: string;
  image?: { data: string; mediaType: string };
}

export interface BrowserToolDef {
  /** Short name: the MCP tool name, and "Browser" + PascalCase for the built-in models. */
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  /** Only looks at the page, so it never needs the user's permission. */
  readOnly: boolean;
  /** `chat` is the chat the agent runs in: it drives that chat's browser, never another's.
   *  `gate` is asked before each step of a batch, which otherwise runs them unchecked. */
  run(input: Record<string, unknown>, chat?: string, gate?: BrowserStepGate): Promise<BrowserToolResult>;
}

/** Whether a step may run: null when it may, or why it was refused. */
export type BrowserStepGate = (step: BrowserToolDef, input: Record<string, unknown>) => Promise<string | null>;

export const BROWSER_MCP_SERVER = "nyxs-browser";

const MAX_TEXT = 40_000;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters)` : text;
}

const target = {
  ref: { type: "string", description: "The element's ref from the latest snapshot, e.g. \"e12\" (or \"f3:e12\" inside an embedded page of another site)." },
  selector: { type: "string", description: "A CSS selector, when there is no ref for the element." },
};

/** What a command answers when it made the page load a new document (see PreviewView/Rust). */
const NAVIGATED = /^Done\. The page navigated to /;

/** `text`, followed by what the page now shows, so the model needn't ask for a snapshot. */
async function withSnapshot(page: PreviewController, text: string): Promise<string> {
  try {
    return `${text}\n\n${await page.exec("snapshot", {})}`;
  } catch {
    return text;
  }
}

async function exec(chat: string | undefined, cmd: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<BrowserToolResult> {
  const page = await ensurePreview(chat);
  const text = await page.exec(cmd, args, timeoutMs);
  return { text: clip(NAVIGATED.test(text) ? await withSnapshot(page, text) : text) };
}

/** Each chat's last screenshot size against the page's, to turn its pixels into page coordinates. */
const lastShot = new Map<string, { scaleX: number; scaleY: number }>();

function toPage(chat: string | undefined, x: unknown, y: unknown): { x: number; y: number } {
  const s = lastShot.get(chat ?? "") ?? { scaleX: 1, scaleY: 1 };
  return { x: Number(x) * s.scaleX, y: Number(y) * s.scaleY };
}

/** Shrinks a PNG screenshot (or a `crop` of it, in its pixels) to at most `max` pixels on its
 *  longer side, as JPEG. */
export async function toJpeg(
  pngBase64: string,
  max = 1280,
  crop?: { x: number; y: number; width: number; height: number },
): Promise<{ data: string; width: number; height: number; sourceWidth: number; sourceHeight: number }> {
  const img = new Image();
  img.src = `data:image/png;base64,${pngBase64}`;
  await img.decode();
  const src = crop ?? { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(img, src.x, src.y, src.width, src.height, 0, 0, width, height);
  return { data: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "", width, height, sourceWidth: img.naturalWidth, sourceHeight: img.naturalHeight };
}

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
    // A minimized window gets no frames.
    setTimeout(resolve, 100);
  });
}

/** Brings the browser to the front and takes a PNG of the page area. */
async function capture(chat: string | undefined): Promise<{ page: PreviewController; png: string; bounds: { x: number; y: number; width: number; height: number } }> {
  const shown = hasActivePreview(chat);
  const page = await ensurePreview(chat);
  // The user may have gone to another tab while the agent works in its own.
  if (!shown) showAgentTab(chat);
  // A panel already on screen only needs its next frames painted; one that was just opened
  // needs a moment to lay out and paint.
  if (shown) await frames(2);
  else await new Promise((r) => setTimeout(r, 400));
  // A browser that isn't on screen isn't laid out, so it has no page area to take, and the
  // user is looking at another chat: showing this one's browser there is what must not happen.
  if (!page.onScreen()) {
    throw new Error(
      "This chat's browser isn't on screen (the user is looking at another chat), so it can't be captured. " +
        "Its page can still be read and driven: use snapshot or find to see it.",
    );
  }
  const bounds = page.bounds();
  if (!bounds || bounds.width < 2 || bounds.height < 2) throw new Error("The built-in browser isn't on screen.");
  const png = await page.capture(bounds);
  return { page, png, bounds };
}

const MAX_BATCH = 20;

const isAbsolutePath = (p: string) => /^([A-Za-z]:[\\/]|[\\/]|~)/.test(p);

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
  csv: "text/csv", json: "application/json", html: "text/html", xml: "application/xml", zip: "application/zip",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
};

/** The type a page sees for an uploaded file, from its extension, as a browser would give it. */
function mediaTypeOf(name: string): string {
  return MEDIA_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

export const BROWSER_TOOLS: BrowserToolDef[] = [
  {
    name: "navigate",
    description:
      "Opens a page in Nyxs' built-in browser (the Preview panel, which the user sees) and waits for it to load. " +
      "It works for websites (https://...) as well as the app you are working on: its dev server (http://localhost:PORT) or an HTML file path relative to the workspace. " +
      "Start the dev server first (Bash, in the background) if it isn't running. Leave url out to reload the current page. " +
      "The project's pages reuse the tab already showing the project; any other site opens in a tab of your own, so a page the user has open is never replaced. " +
      "To read the page the user has open, use snapshot without navigating. " +
      "Returns what the loaded page shows, as snapshot does; then click/fill/press_key to interact with it.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "https://site.com/path, http://localhost:PORT/path, or an .html file. Omit to reload." } },
      additionalProperties: false,
    },
    readOnly: false,
    run: async ({ url }, chat) => {
      let page = await ensurePreview(chat);
      const asked = typeof url === "string" ? url.trim() : "";
      // A remote project's dev server runs on its machine: its localhost goes through a tunnel.
      // The project is the chat's own: the one on screen may be another chat's.
      const target = asked ? await tunnelUrl(asked, previewWorkspace(chat)) : "";
      if (target) page = await previewForAddress(target, chat);
      const text = target ? await page.navigate(target) : await page.reload();
      // A page that loaded comes with what it shows, which is what the model asks for next.
      if (!/^(Loaded|Reloaded) /.test(text)) return { text };
      return { text: clip(await withSnapshot(page, text.replace(/ Use snapshot to read it and click\/fill\/press_key to use it\./, ""))) };
    },
  },
  {
    name: "snapshot",
    description:
      "Reads the page open in the built-in browser as an outline: headings, text, links, buttons and form fields with their values. " +
      "Each interactive element has a ref (ref=e12) to pass to click, fill or scroll; an element keeps its ref while it stays on the page. " +
      "On a website, embedded pages of other sites (payment fields, players) can show under their iframe line, with refs like f3:e12 that work the same. " +
      "By default it shows what is on screen and counts what is off screen; area \"page\" reads everything. " +
      "Actions already report what they changed, so you rarely need a snapshot after one. Prefer this to screenshot for reading text and finding elements.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", enum: ["viewport", "page"], description: "\"viewport\" (default): what is on screen. \"page\": the whole page." },
        filter: { type: "string", enum: ["all", "interactive"], description: "\"interactive\": only what can be clicked or typed into." },
        ref: { type: "string", description: "Read only this element and what is inside it (all of it, on screen or not)." },
      },
      additionalProperties: false,
    },
    readOnly: true,
    run: (input, chat) => exec(chat, "snapshot", input),
  },
  {
    name: "find",
    description:
      "Finds elements of the page in the built-in browser by their text, label or role (\"button save\", \"email\"), across the whole page, on screen or not, " +
      "and returns them with refs. Cheaper than reading a long page with snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for; every word must match. Case and accents don't matter." },
        limit: { type: "number", description: "Most matches to return (default 20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,
    run: (input, chat) => exec(chat, "find", input),
  },
  {
    name: "click",
    description:
      "Clicks an element of the page in the built-in browser, the way a user would (pointer and mouse events, then click). " +
      "It first scrolls the element into view and checks that it is enabled, visible and not covered by something else. " +
      "Returns what changed: the URL, dialogs, new or changed controls with their refs, messages and errors (or the new page, if it navigated).",
    inputSchema: {
      type: "object",
      properties: { ...target, force: { type: "boolean", description: "Click even if another element covers it." } },
      additionalProperties: false,
    },
    readOnly: false,
    run: (input, chat) => exec(chat, "click", input),
  },
  {
    name: "fill",
    description:
      "Sets the value of a form field in the built-in browser and fires input and change events, as typing would. " +
      "Works on text fields, textareas, contenteditable elements, selects (pass the option's value or visible text) and checkboxes or radios (\"true\" or \"false\"). " +
      "For several fields use fill_form.",
    inputSchema: {
      type: "object",
      properties: { ...target, value: { type: "string", description: "The value to set." } },
      required: ["value"],
      additionalProperties: false,
    },
    readOnly: false,
    run: (input, chat) => exec(chat, "fill", input),
  },
  {
    name: "fill_form",
    description: "Fills several form fields of the page in the built-in browser in one go, in order, as fill does for each. Stops at the first field that fails.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: { ...target, value: { type: "string", description: "The value to set." } },
            required: ["value"],
            additionalProperties: false,
          },
          description: "The fields and their values: [{ref: \"e3\", value: \"Ana\"}, ...].",
        },
      },
      required: ["fields"],
      additionalProperties: false,
    },
    readOnly: false,
    run: (input, chat) => exec(chat, "fill_form", input),
  },
  {
    name: "upload",
    description:
      "Uploads files from this computer to the page in the built-in browser, as if the user had picked them: on a file field, or on the button or drop area that stands for one (an \"Upload\" button, a \"drag & drop\" box). " +
      "Use it instead of clicking such a button: that opens the system's file picker, which the agent can't use. Paths are absolute, or relative to the project. At most 20 MB per file.",
    inputSchema: {
      type: "object",
      properties: {
        ...target,
        paths: { type: "array", items: { type: "string" }, description: "The files to upload, e.g. [\"assets/logo.png\"]." },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async ({ ref, selector, paths }, chat) => {
      const list = Array.isArray(paths) ? paths.map(String).filter((p) => p.trim()) : [];
      if (!list.length) throw new Error("Pass the paths of the files to upload.");
      const workspace = previewWorkspace(chat);
      const files = await Promise.all(
        list.map(async (p) => {
          const path = isAbsolutePath(p) || !workspace ? p : `${workspace.replace(/[\\/]+$/, "")}/${p.replace(/^\.[\\/]/, "")}`;
          const read = await invoke<{ name: string; base64: string }>("agent_read_upload", { path });
          return { name: read.name, type: mediaTypeOf(read.name), data: read.base64 };
        }),
      );
      return exec(chat, "upload", { ref, selector, files }, 60_000);
    },
  },
  {
    name: "press_key",
    description:
      "Presses a key on the focused element of the page in the built-in browser: Enter (submits a form), Tab, Escape, Backspace, ArrowDown, a single character, " +
      "or a combination such as Control+a. Click or fill an element first to focus it.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "Key name as in KeyboardEvent.key, optionally with modifiers: \"Enter\", \"Shift+Tab\"." } },
      required: ["key"],
      additionalProperties: false,
    },
    readOnly: false,
    run: (input, chat) => exec(chat, "press", input),
  },
  {
    name: "scroll",
    description: "Scrolls the page in the built-in browser: to an element (ref or selector), to the top or bottom, or by a number of pixels. Returns what is on screen afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        ...target,
        to: { type: "string", enum: ["top", "bottom"], description: "Scroll to the top or the bottom of the page." },
        y: { type: "number", description: "Pixels to scroll down (negative scrolls up). Defaults to most of a screen." },
      },
      additionalProperties: false,
    },
    readOnly: false,
    run: (input, chat) => exec(chat, "scroll", input),
  },
  {
    name: "eval",
    description:
      "Runs JavaScript in the page open in the built-in browser and returns the result as JSON. " +
      "Pass an expression (document.title) or statements with a return; await works. " +
      "Use it for what the snapshot doesn't show: app state, localStorage, computed styles, element sizes.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "JavaScript to run in the page." } },
      required: ["expression"],
      additionalProperties: false,
    },
    readOnly: false,
    run: ({ expression }, chat) => exec(chat, "eval", { expression }, 30_000),
  },
  {
    name: "console_logs",
    description:
      "Reads what the page in the built-in browser logged since it loaded: console messages, uncaught errors, unhandled promise rejections and failed network requests. " +
      "Check it after a change or an action to find runtime errors.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", description: "Comma-separated levels to keep: log, info, warn, error, debug, network. All by default." },
        limit: { type: "number", description: "How many of the latest entries to return (default 100)." },
        clear: { type: "boolean", description: "Empty the log after reading it, to see only what comes next." },
      },
      additionalProperties: false,
    },
    readOnly: true,
    run: (input, chat) => exec(chat, "console", input),
  },
  {
    name: "screenshot",
    description:
      "Takes a screenshot of what the built-in browser shows (local pages and external sites). " +
      "Use it to check layout and visuals, and with click_at for what has no ref (a canvas, a map); use snapshot to read text and find elements.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    run: async (_input, chat) => {
      const { page, png, bounds } = await capture(chat);
      const jpeg = await toJpeg(png);
      lastShot.set(chat ?? "", { scaleX: bounds.width / jpeg.width, scaleY: bounds.height / jpeg.height });
      const url = page.info().url;
      return {
        text:
          `Screenshot of ${url || "the built-in browser"} (${jpeg.width}x${jpeg.height}; click_at and zoom take this image's pixels). ` +
          "It is taken from the screen, so a window covering Nyxs would show in it.",
        image: { data: jpeg.data, mediaType: "image/jpeg" },
      };
    },
  },
  {
    name: "zoom",
    description:
      "Takes a close-up of a region of the built-in browser at full resolution, to read small text or check details. " +
      "The region is in the pixels of the latest screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Left edge, in screenshot pixels." },
        y: { type: "number", description: "Top edge, in screenshot pixels." },
        width: { type: "number", description: "Width, in screenshot pixels." },
        height: { type: "number", description: "Height, in screenshot pixels." },
      },
      required: ["x", "y", "width", "height"],
      additionalProperties: false,
    },
    readOnly: true,
    run: async ({ x, y, width, height }, chat) => {
      const { png, bounds } = await capture(chat);
      // Screenshot pixels -> the page's CSS pixels -> the capture's own (device) pixels.
      const from = toPage(chat, x, y);
      const to = toPage(chat, Number(x) + Number(width), Number(y) + Number(height));
      const full = await toJpeg(png, 1);
      const dpr = full.sourceWidth / bounds.width;
      const left = Math.max(0, Math.min(from.x, to.x) * dpr);
      const top = Math.max(0, Math.min(from.y, to.y) * dpr);
      const crop = {
        x: left,
        y: top,
        width: Math.min(full.sourceWidth - left, Math.abs(to.x - from.x) * dpr),
        height: Math.min(full.sourceHeight - top, Math.abs(to.y - from.y) * dpr),
      };
      if (!(crop.width >= 1 && crop.height >= 1)) throw new Error("That region is outside the browser. Take a screenshot to see its size.");
      const jpeg = await toJpeg(png, 1280, crop);
      const r = [x, y, width, height].map((v) => Math.round(Number(v)));
      return {
        text: `Close-up of the screenshot region (${r[0]}, ${r[1]}) ${r[2]}x${r[3]}, at ${jpeg.width}x${jpeg.height}. click_at still takes the full screenshot's pixels.`,
        image: { data: jpeg.data, mediaType: "image/jpeg" },
      };
    },
  },
  {
    name: "click_at",
    description:
      "Clicks a point of the page in the built-in browser, in the pixels of the latest screenshot. " +
      "For what has no ref in the snapshot: a canvas, a video, a map. Prefer click with a ref otherwise. Embedded pages from other sites can't be clicked into.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal position, in screenshot pixels." },
        y: { type: "number", description: "Vertical position, in screenshot pixels." },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    readOnly: false,
    run: ({ x, y }, chat) => exec(chat, "click_at", toPage(chat, x, y)),
  },
  {
    name: "batch",
    description:
      `Runs several browser actions in a row in one call (at most ${MAX_BATCH}), for steps you can plan ahead: fill and submit a form, open a menu and pick an item. ` +
      "It stops at the first action that fails, and when the page navigates, since later refs would belong to the old page. Returns what each action said.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "A browser tool: navigate, click, fill, fill_form, press_key, scroll, click_at, snapshot, find, screenshot..." },
              input: { type: "object", description: "That tool's input, as you would pass it to the tool." },
            },
            required: ["tool"],
            additionalProperties: false,
          },
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
    readOnly: false,
    run: ({ actions }, chat, gate) => runBatch(Array.isArray(actions) ? actions : [], chat, gate),
  },
];

async function runBatch(actions: unknown[], chat: string | undefined, gate?: BrowserStepGate): Promise<BrowserToolResult> {
  if (!actions.length) throw new Error("Pass the actions to run: [{tool, input}].");
  if (actions.length > MAX_BATCH) throw new Error(`A batch runs at most ${MAX_BATCH} actions.`);
  const parts: string[] = [];
  let image: BrowserToolResult["image"];
  for (let i = 0; i < actions.length; i++) {
    const step = (actions[i] ?? {}) as { tool?: unknown; input?: unknown };
    const def = browserToolFor(String(step.tool ?? "")) ?? BROWSER_TOOLS.find((d) => d.name === step.tool);
    const left = actions.length - i - 1;
    const rest = left ? ` The other ${left} action${left === 1 ? " wasn't" : "s weren't"} run.` : "";
    if (!def || def.name === "batch") throw new Error([...parts, `${i + 1}. ${String(step.tool)}: there is no such browser tool.${rest}`].join("\n\n"));
    const input = (step.input ?? {}) as Record<string, unknown>;
    const denied = gate ? await gate(def, input) : null;
    if (denied) {
      parts.push(`${i + 1}. ${def.name}: ${denied}${rest}`);
      break;
    }
    try {
      const out = await def.run(input, chat);
      parts.push(`${i + 1}. ${def.name}: ${out.text}`);
      if (out.image) image = out.image;
      if (left && def.name !== "navigate" && NAVIGATED.test(out.text)) {
        parts.push(`The page navigated, so the other ${left} action${left === 1 ? " wasn't" : "s weren't"} run: their refs belong to the old page.`);
        break;
      }
    } catch (e) {
      throw new Error([...parts, `${i + 1}. ${def.name} failed: ${e instanceof Error ? e.message : String(e)}${rest}`].join("\n\n"), { cause: e });
    }
  }
  return { text: clip(parts.join("\n\n")), image };
}

/** Name of a browser tool for the built-in models: "navigate" → "BrowserNavigate". */
export function builtinBrowserToolName(name: string): string {
  return "Browser" + name.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

const BY_NAME = new Map<string, BrowserToolDef>();
for (const def of BROWSER_TOOLS) {
  BY_NAME.set(builtinBrowserToolName(def.name), def);
  BY_NAME.set(`mcp__${BROWSER_MCP_SERVER}__${def.name}`, def);
}

/** The browser tool behind a tool name, as either kind of agent calls it. */
export function browserToolFor(toolName: string): BrowserToolDef | undefined {
  return BY_NAME.get(toolName);
}

/** What the chat shows for a browser tool call: "Navegador" and what it did. */
export function describeBrowserCall(def: BrowserToolDef, input: Record<string, unknown>): string {
  const count = (v: unknown, one: string, many: string) => (Array.isArray(v) ? `${v.length} ${v.length === 1 ? one : many}` : undefined);
  const point = typeof input.x === "number" && typeof input.y === "number" ? `${Math.round(input.x)}, ${Math.round(input.y)}` : undefined;
  const what =
    input.url ?? input.ref ?? input.selector ?? input.query ?? input.key ?? input.to ?? input.expression ??
    count(input.fields, "field", "fields") ?? count(input.actions, "action", "actions") ?? count(input.paths, "file", "files") ?? point ?? "";
  const detail = String(what).replace(/\s+/g, " ").slice(0, 80);
  return detail ? `${def.name} · ${detail}` : def.name;
}
