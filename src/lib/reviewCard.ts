/** The `nyxs-review` block the /review skill ends with (see skills.ts), drawn as a card. */
export interface ReviewFinding {
  severity: "high" | "med" | "low";
  file: string;
  line?: number;
  title: string;
  detail: string;
  fix: string;
}

export interface ReviewReport {
  verdict: string;
  findings: ReviewFinding[];
}

const SEVERITIES = ["high", "med", "low"] as const;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The report in the block, or null while it's still streaming in or isn't valid. Findings
 *  without a file or a title are dropped; an unknown severity counts as "med". */
export function parseReviewReport(content: string): ReviewReport | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const raw = (data as { findings?: unknown }).findings;
  const findings: ReviewFinding[] = (Array.isArray(raw) ? raw : [])
    .map((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      const sev = text(o.severity).toLowerCase().replace(/^medium$/, "med");
      const line = typeof o.line === "number" && o.line > 0 ? Math.floor(o.line) : undefined;
      return {
        severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as ReviewFinding["severity"]) : "med",
        file: text(o.file).replace(/\\/g, "/").replace(/^\.\//, ""),
        line,
        title: text(o.title),
        detail: text(o.detail),
        fix: text(o.fix),
      };
    })
    .filter((f) => f.file && f.title)
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return { verdict: text((data as { verdict?: unknown }).verdict), findings };
}

export const findingWhere = (f: ReviewFinding) => (f.line ? `${f.file}:${f.line}` : f.file);

/** One finding as the agent reads it in a fix request. */
export function describeFinding(f: ReviewFinding, fixLabel: string): string {
  return [`\`${findingWhere(f)}\` — ${f.title}`, f.detail, f.fix ? `${fixLabel} ${f.fix}` : ""].filter(Boolean).join("\n");
}
