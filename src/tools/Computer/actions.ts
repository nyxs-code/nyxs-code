/** What the Computer tool can do, as the model names it: Claude's computer-use actions (models
 *  trained on them call them right), plus Codex-style window reading and acting on a window's
 *  controls by number. */
export const COMPUTER_ACTIONS = [
  "screenshot",
  "zoom",
  "list_windows",
  "focus_window",
  "get_window_state",
  "click_element",
  "set_value",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
  "cursor_position",
] as const;

export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

/** Actions that only look: they run without asking, like the browser's snapshot. */
export const COMPUTER_LOOK_ACTIONS = new Set<string>(["screenshot", "zoom", "wait", "cursor_position", "list_windows", "get_window_state"]);

/** The Computer tool's MCP server, for the CLI agents (Claude Code, Codex...). */
export const COMPUTER_MCP_SERVER = "nyxs-computer";
export const COMPUTER_MCP_TOOL = "computer";

/** True for the Computer tool under either name (built in, or through MCP). */
export function isComputerTool(toolName: string): boolean {
  return toolName === "Computer" || toolName === `mcp__${COMPUTER_MCP_SERVER}__${COMPUTER_MCP_TOOL}`;
}
