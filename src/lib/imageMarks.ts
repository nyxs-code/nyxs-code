/** The marks drawn over an image in the image viewer (ImageAnnotator), and their drawing on a canvas
 *  for the annotated copy. */
import type { AnnotShape } from "@/lib/annotations";

export type Point = [number, number];

/** One drawing on the image, in the image's own pixels. */
export interface Mark {
  kind: "pen" | AnnotShape;
  color: string;
  /** Line width in image pixels. */
  width: number;
  points: Point[];
  /** A step's number. */
  n?: number;
}

/** The arrow's head: two short lines back from the tip. */
export function arrowHead([x1, y1]: Point, [x2, y2]: Point, size: number): [Point, Point] {
  const a = Math.atan2(y2 - y1, x2 - x1);
  return [
    [x2 - size * Math.cos(a - 0.45), y2 - size * Math.sin(a - 0.45)],
    [x2 - size * Math.cos(a + 0.45), y2 - size * Math.sin(a + 0.45)],
  ];
}

export const stepRadius = (m: Mark) => m.width * 3 + 8;

/** Draws the marks on a canvas the image's size, for the annotated copy. */
export function drawMarks(ctx: CanvasRenderingContext2D, marks: Mark[]): void {
  for (const m of marks) {
    ctx.strokeStyle = m.color;
    ctx.fillStyle = m.color;
    ctx.lineWidth = m.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const [a, b] = [m.points[0], m.points[m.points.length - 1]];
    ctx.beginPath();
    if (m.kind === "pen") m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    else if (m.kind === "line") {
      ctx.moveTo(...a);
      ctx.lineTo(...b);
    } else if (m.kind === "arrow") {
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      const [h1, h2] = arrowHead(a, b, m.width * 4 + 10);
      ctx.moveTo(...h1);
      ctx.lineTo(...b);
      ctx.lineTo(...h2);
    } else if (m.kind === "rect") ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    else if (m.kind === "ellipse") ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
    else if (m.kind === "step") {
      const r = stepRadius(m);
      ctx.arc(a[0], a[1], r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${r * 1.1}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(m.n), a[0], a[1]);
      continue;
    }
    ctx.stroke();
  }
}
