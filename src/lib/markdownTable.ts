export type CellAlign = "left" | "center" | "right" | null;

// How a markdown table is drawn in the chat. A grid only pays off when the
// columns hold numbers you read top to bottom; otherwise rows read better as
// text, and a handful of rows compares best side by side.
export type TableLayout = "table" | "compare" | "list";

const EMPTY_CELL = /^(?:|-|–|—|n\/a|\?)$/i;
const NUMERIC_CELL =
  /^[~≈<>≤≥+\-−]?\s*[$€£¥]?\s*\d[\d.,'\s]*\s*(?:%|[kmb]|ms|s|h|min|[kmgt]i?b|b|x|×|tokens?|usd|eur|€|\$)?$/i;

const plain = (cell: string) => cell.replace(/\*\*|`/g, "").trim();

export function parseAlign(sepCells: string[]): CellAlign[] {
  return sepCells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

export function numericColumns(header: string[], rows: string[][]): boolean[] {
  return header.map((_, ci) => {
    let filled = 0;
    let numeric = 0;
    for (const r of rows) {
      const v = plain(r[ci] ?? "");
      if (EMPTY_CELL.test(v)) continue;
      filled++;
      if (NUMERIC_CELL.test(v)) numeric++;
    }
    return numeric > 0 && numeric / filled >= 0.8;
  });
}

export function chooseTableLayout(header: string[], rows: string[][]): TableLayout {
  // The first column names the row, so only the rest counts as data.
  const dataCols = numericColumns(header, rows).slice(1);
  const numeric = dataCols.filter(Boolean).length;
  if (numeric > 0 && numeric * 2 >= dataCols.length) return "table";

  const longest = Math.max(0, ...rows.flat().map((c) => plain(c).length));
  if (rows.length >= 2 && rows.length <= 4 && header.length >= 3 && header.length <= 4 && longest <= 140) {
    return "compare";
  }
  return "list";
}
