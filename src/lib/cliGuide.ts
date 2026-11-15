import { appendPromptFor } from "./claudeCode";
import { BROWSER_MCP_SERVER } from "./browserTools";
import { VIDEO_MCP_SERVER, VIDEO_RULES } from "./videoTools";
import { SESSIONS_MCP_SERVER } from "./sessionTools";
import { CHAT_MCP_SERVER, ASK_TOOL, PLAN_TOOL } from "./chatMcp";
import { cachedNyxsMemory } from "./preflight";
import { VISUAL_PREVIEW_PROMPT } from "./prompts/visualPreview";
import { PR_CREATED_PROMPT } from "./prCreatedTag";

/**
 * What Nyxs tells Grok and Antigravity once per session, the way Claude Code gets it with
 * --append-system-prompt: how to draw previews in the chat, to use Nyxs' browser rather than
 * their own, Nyxs' sessions and chat tools when they have them, and the project's NYXS.md.
 * Grok takes it as its session's rules (`_meta.rules` on `session/new`); Antigravity has no
 * such flag, so it goes before the first message of each conversation.
 */

export type GuidedCli = "grok" | "antigravity";

export interface GuideOptions {
  /** The built-in browser is served to this session. */
  browser: boolean;
  /** The sessions tools are served to this session. */
  sessions: boolean;
  /** The video editor's tools are served to this session. */
  video?: boolean;
  /** The chat tools (questions, plan review) are served to this session. */
  chatTools: boolean;
  workspace?: string | null;
}

/** How the CLI names a tool of an MCP server: Grok calls `server__tool` with use_tool,
 *  Antigravity calls it through call_mcp_tool. */
function toolRef(cli: GuidedCli, server: string, tool: string): string {
  return cli === "grok" ? `\`${server}__${tool}\`` : `\`${tool}\` (server \`${server}\`, through call_mcp_tool)`;
}

export function browserNote(cli: GuidedCli): string {
  const own = cli === "grok" ? "your own web tools" : "your own browser tools (open_browser_url, browser_*, browser_subagent)";
  return `<nyxs_browser>
You are running inside the Nyxs app. When the user asks to open or show a web page, a site, a video or "the browser", use Nyxs' built-in browser: the MCP server \`${BROWSER_MCP_SERVER}\` (e.g. ${toolRef(cli, BROWSER_MCP_SERVER, "navigate")} with the url). It opens in the Preview panel next to the chat, where the user sees it, and its other tools (snapshot, click, fill…) read and drive the page. Don't open pages with ${own} or a shell command (Start-Process, start, open, xdg-open) unless the user asks for their system browser.
</nyxs_browser>`;
}

function sessionsNote(cli: GuidedCli): string {
  return `# The user's sessions
You run inside Nyxs, which keeps the user's conversations as sessions listed in its Recents. When the user asks you to create, start or open a new session (in Spanish "nueva sesión", often typed "sesion" or "secion"), call ${toolRef(cli, SESSIONS_MCP_SERVER, "create_session")} right away, with the model and effort they named in their own words if they named any: don't use your own sub-agents for it, and don't look anything up first. Its first reply comes back to you as a message, so end your turn with one short line until it does. To read, message, rename or archive their other sessions, use the other tools of \`${SESSIONS_MCP_SERVER}\`.`;
}

function videoNote(cli: GuidedCli): string {
  return `# Videos
You run inside Nyxs, which has a video editor in its Video view. When the user asks to make, edit, cut, caption or render a video, use the MCP server \`${VIDEO_MCP_SERVER}\` (start with ${toolRef(cli, VIDEO_MCP_SERVER, "guide")}): it acts on the live editor, where the user watches each change and can undo it. ${VIDEO_RULES}`;
}

function chatNote(cli: GuidedCli): string {
  return `# Questions and plans
When a decision is genuinely the user's (which library, which approach, which scope), ask with ${toolRef(cli, CHAT_MCP_SERVER, ASK_TOOL)}: it shows Nyxs' question card and returns their answers. When Nyxs has you in plan mode, ${toolRef(cli, CHAT_MCP_SERVER, PLAN_TOOL)} is offered too: hand your finished plan to it for the user's review, then end your turn and wait for their reply.`;
}

/** The fixed part of the guide, without the project's instructions. */
export function guideText(cli: GuidedCli, o: Omit<GuideOptions, "workspace">): string {
  const parts = [VISUAL_PREVIEW_PROMPT];
  if (o.browser) parts.push(browserNote(cli));
  if (o.sessions) parts.push(sessionsNote(cli));
  if (o.video) parts.push(videoNote(cli));
  if (o.chatTools) parts.push(chatNote(cli));
  parts.push(PR_CREATED_PROMPT);
  return parts.join("\n\n");
}

/** The whole guide: the fixed part and the project's NYXS.md after it, cut to fit as Claude Code's. */
export async function sessionGuide(cli: GuidedCli, o: GuideOptions): Promise<string> {
  const memory = o.workspace ? await cachedNyxsMemory(o.workspace).catch(() => "") : "";
  return appendPromptFor(guideText(cli, o), memory);
}
