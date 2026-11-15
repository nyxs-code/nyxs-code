import { Fragment, useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { chooseTableLayout, numericColumns, type CellAlign } from "@/lib/markdownTable";

type RenderInline = (text: string, keyPrefix: string) => ReactNode[];

interface Props {
  header: string[];
  rows: string[][];
  align: CellAlign[];
  id: number;
  inline: RenderInline;
}

export function MarkdownTable({ header, rows, align, id, inline }: Props) {
  const layout = useMemo(() => chooseTableLayout(header, rows), [header, rows]);
  if (layout === "table") return <NumericTable header={header} rows={rows} align={align} id={id} inline={inline} />;
  if (layout === "compare") {
    // Both are rendered and a container query picks one, so a narrow chat
    // (side panel, small window) gets the list instead of squeezed cards.
    const fit = COMPARE_FIT[rows.length as 2 | 3 | 4];
    return (
      <div className="@container">
        <CompareCards header={header} rows={rows} id={id} inline={inline} className={fit.cards} />
        <RowList header={header} rows={rows} id={id} inline={inline} className={fit.list} />
      </div>
    );
  }
  return <RowList header={header} rows={rows} id={id} inline={inline} />;
}

// Each card needs about 10rem; the classes are spelled out so Tailwind sees them.
const COMPARE_FIT = {
  2: { cards: "hidden @min-[21rem]:grid grid-cols-2", list: "@min-[21rem]:hidden" },
  3: { cards: "hidden @min-[32rem]:grid grid-cols-3", list: "@min-[32rem]:hidden" },
  4: { cards: "hidden @min-[42rem]:grid grid-cols-4", list: "@min-[42rem]:hidden" },
};

const hasText = (c: string | undefined) => !!c && c.trim() !== "";

function fieldsOf(header: string[], row: string[]) {
  return header.slice(1).flatMap((label, j) => {
    const value = row[j + 1];
    return hasText(value) ? [{ label, value: value!, col: j + 1 }] : [];
  });
}

type BlockProps = Omit<Props, "align"> & { className?: string };

function RowList({ header, rows, id, inline, className }: BlockProps) {
  // With a single value column the header adds nothing next to each value.
  const showLabels = header.length > 2;
  return (
    <div
      className={cn(
        "my-2.5 grid items-baseline gap-x-4 text-[14px] leading-[1.6]",
        showLabels ? "grid-cols-[fit-content(12rem)_fit-content(9rem)_minmax(0,1fr)]" : "grid-cols-[fit-content(14rem)_minmax(0,1fr)]",
        className,
      )}
    >
      {rows.map((r, ri) => {
        const fields = fieldsOf(header, r);
        const gap = ri > 0 ? "pt-3" : "";
        const name = (
          <div
            className={cn("font-medium text-text-100 break-words", gap, !fields.length && "col-span-full")}
            style={fields.length > 1 ? { gridRow: `span ${fields.length}` } : undefined}
          >
            {inline(r[0] ?? "", `tl${id}-${ri}`)}
          </div>
        );
        return (
          <Fragment key={ri}>
            {name}
            {fields.map((f, fi) => (
              <Fragment key={f.col}>
                {showLabels && (
                  <div className={cn("text-[12px] text-text-400 break-words", fi === 0 && gap)}>
                    {inline(f.label, `tlh${id}-${ri}-${f.col}`)}
                  </div>
                )}
                <div className={cn("text-text-200 break-words", fi === 0 && gap)}>
                  {inline(f.value, `tlv${id}-${ri}-${f.col}`)}
                </div>
              </Fragment>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

function CompareCards({ header, rows, id, inline, className }: BlockProps) {
  return (
    <div className={cn("my-2.5 gap-2 text-[14px] leading-[1.55]", className)}>
      {rows.map((r, ri) => (
        <div key={ri} className="rounded-[8px] bg-bg-200 px-3 py-2.5 min-w-0">
          <div className="font-medium text-text-100 mb-2 break-words">{inline(r[0] ?? "", `tc${id}-${ri}`)}</div>
          <div className="space-y-2">
            {fieldsOf(header, r).map((f) => (
              <div key={f.col} className="break-words">
                <div className="text-[12px] text-text-400">{inline(f.label, `tch${id}-${ri}-${f.col}`)}</div>
                <div className="text-text-200">{inline(f.value, `tcv${id}-${ri}-${f.col}`)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const ALIGN_CLASS = { left: "text-left", center: "text-center", right: "text-right" } as const;

function NumericTable({ header, rows, align, id, inline }: Props) {
  const numeric = useMemo(() => numericColumns(header, rows), [header, rows]);
  const alignOf = (ci: number) => ALIGN_CLASS[align[ci] ?? (ci > 0 && numeric[ci] ? "right" : "left")];
  return (
    <div className="my-2.5 overflow-x-auto custom-scrollbar">
      <table className="text-[13.5px] border-collapse">
        <thead>
          <tr>
            {header.map((c, ci) => (
              <th key={ci} className={cn("px-3 first:pl-0 pb-1.5 font-normal text-[12px] text-text-400 border-b border-bg-300 whitespace-nowrap", alignOf(ci))}>
                {inline(c, `th${id}-${ci}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-bg-200 last:border-b-0">
              {header.map((_, ci) => (
                <td
                  key={ci}
                  className={cn(
                    "px-3 first:pl-0 py-1.5 align-top",
                    alignOf(ci),
                    ci === 0 ? "font-medium text-text-100" : "text-text-200",
                    numeric[ci] && "tabular-nums whitespace-nowrap",
                  )}
                >
                  {inline(r[ci] ?? "", `td${id}-${ri}-${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
