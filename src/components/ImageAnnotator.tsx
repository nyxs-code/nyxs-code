import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AnnotationBar } from "@/components/views/AnnotationBar";
import { ANNOT_COLORS, ANNOT_WIDTHS, type AnnotShape, type AnnotTool } from "@/lib/annotations";
import { useTranslations } from "@/lib/i18n";
import { arrowHead, drawMarks, stepRadius, type Mark, type Point } from "@/lib/imageMarks";

function MarkSvg({ m }: { m: Mark }) {
  const common = { stroke: m.color, strokeWidth: m.width, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const [a, b] = [m.points[0], m.points[m.points.length - 1]];
  switch (m.kind) {
    case "pen":
      return <polyline points={m.points.map((p) => p.join(",")).join(" ")} {...common} />;
    case "line":
      return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...common} />;
    case "arrow": {
      const [h1, h2] = arrowHead(a, b, m.width * 4 + 10);
      return <polyline points={`${h1.join(",")} ${b.join(",")} ${h2.join(",")}`} {...common} />;
    }
    case "rect":
      return <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} {...common} />;
    case "ellipse":
      return <ellipse cx={(a[0] + b[0]) / 2} cy={(a[1] + b[1]) / 2} rx={Math.abs(b[0] - a[0]) / 2} ry={Math.abs(b[1] - a[1]) / 2} {...common} />;
    case "step": {
      const r = stepRadius(m);
      return (
        <g>
          <circle cx={a[0]} cy={a[1]} r={r} fill={m.color} />
          <text x={a[0]} y={a[1]} fill="#fff" fontSize={r * 1.1} fontWeight={700} textAnchor="middle" dominantBaseline="central" fontFamily="system-ui, sans-serif">
            {m.n}
          </text>
        </g>
      );
    }
  }
}

/** The image with drawing tools over it (pen, shapes, numbered steps), like Claude's image
 *  annotations; "Add to message" attaches the drawn copy as a PNG. */
export function ImageAnnotator({
  src,
  name,
  onDone,
  onClose,
}: {
  src: string;
  name: string;
  onDone: (file: File) => void;
  onClose: () => void;
}) {
  const t = useTranslations().messageExtra;
  const imgRef = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<AnnotTool>("pen");
  const [shape, setShape] = useState<AnnotShape>("arrow");
  const [color, setColor] = useState<string>(ANNOT_COLORS[0]);
  const [width, setWidth] = useState<number>(ANNOT_WIDTHS[1]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [undone, setUndone] = useState<Mark[]>([]);
  const drawing = useRef<Mark | null>(null);
  const [live, setLive] = useState<Mark | null>(null);

  /** A pointer position in the image's own pixels, and how many of them one screen pixel is. */
  const at = (e: ReactPointerEvent): { p: Point; scale: number } => {
    const box = imgRef.current!.getBoundingClientRect();
    const scale = size && box.width ? size.w / box.width : 1;
    return { p: [(e.clientX - box.left) * scale, (e.clientY - box.top) * scale], scale };
  };

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!size || tool === "select" || tool === "text") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { p, scale } = at(e);
    const kind = tool === "pen" ? "pen" : tool;
    const mark: Mark = { kind, color, width: width * scale, points: [p, p] };
    if (kind === "step") {
      mark.n = marks.filter((m) => m.kind === "step").length + 1;
      setMarks((ms) => [...ms, mark]);
      setUndone([]);
      return;
    }
    drawing.current = mark;
    setLive(mark);
  };
  const onMove = (e: ReactPointerEvent) => {
    const m = drawing.current;
    if (!m) return;
    const { p } = at(e);
    const next = { ...m, points: m.kind === "pen" ? [...m.points, p] : [m.points[0], p] };
    drawing.current = next;
    setLive(next);
  };
  const onUp = () => {
    const m = drawing.current;
    drawing.current = null;
    setLive(null);
    if (!m) return;
    const [a, b] = [m.points[0], m.points[m.points.length - 1]];
    // A click without a drag draws nothing (except the pen's dot).
    if (m.kind !== "pen" && Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) return;
    setMarks((ms) => [...ms, m]);
    setUndone([]);
  };

  const exportImage = async () => {
    const img = imgRef.current;
    if (!img || !size) return;
    const canvas = document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, size.w, size.h);
    drawMarks(ctx, marks);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) return;
    const base = name.replace(/\.[^.]+$/, "") || "image";
    onDone(new File([blob], `${base}-annotated.png`, { type: "image/png" }));
  };

  return (
    <div className="flex max-h-[92vh] max-w-[92vw] flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
      <div className="relative min-h-0">
        <img
          ref={imgRef}
          src={src}
          alt={name}
          draggable={false}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="block max-h-[80vh] max-w-[90vw] select-none rounded-lg object-contain shadow-2xl"
        />
        {size && (
          <svg
            aria-label={t.annotateImage}
            viewBox={`0 0 ${size.w} ${size.h}`}
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            {marks.map((m, i) => <MarkSvg key={i} m={m} />)}
            {live && <MarkSvg m={live} />}
          </svg>
        )}
      </div>
      <AnnotationBar
        pageTools={false}
        addLabel={t.addToMessage}
        tool={tool}
        shape={shape}
        color={color}
        width={width}
        canUndo={marks.length > 0}
        canRedo={undone.length > 0}
        canClear={marks.length > 0}
        onTool={setTool}
        onShape={setShape}
        onColor={setColor}
        onWidth={setWidth}
        onUndo={() => {
          setUndone((u) => [...u, marks[marks.length - 1]]);
          setMarks((ms) => ms.slice(0, -1));
        }}
        onRedo={() => {
          setMarks((ms) => [...ms, undone[undone.length - 1]]);
          setUndone((u) => u.slice(0, -1));
        }}
        onClear={() => {
          setUndone([]);
          setMarks([]);
        }}
        onAddToChat={() => void exportImage()}
        onClose={onClose}
      />
    </div>
  );
}
