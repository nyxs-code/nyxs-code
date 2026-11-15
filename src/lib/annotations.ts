/** Shapes drawn by dragging (or, for a step, by clicking), as the page's annotation layer
 *  names them (src-tauri/src/agent/preview_agent.js). */
export type AnnotShape = "line" | "arrow" | "rect" | "ellipse" | "step";
export type AnnotTool = "select" | "pen" | "text" | AnnotShape;

export const ANNOT_COLORS = ["#e03131", "#1c7ed6", "#2f9e44", "#1a1a1a", "#ffffff"] as const;
export const ANNOT_WIDTHS = [2, 4, 6, 10] as const;
