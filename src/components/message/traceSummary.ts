import type { ToolDetail } from "@/lib/agentTools";
import type { Translations } from "@/locales/types";
import { toolCompleted, type ToolEnd } from "./parse";
import type { WorkItem } from "./liveFormat";
import { FILE_EDIT_TOOLS, basename } from "./toolFormat";

const READ_TOOLS = new Set(["Read", "ReadPdf", "WatchVideo", "ListDir"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "WebSearch", "RetrieveContext"]);
/** Reading a web page is reading, not searching: counted as pages, apart from files. */
const PAGE_TOOLS = new Set(["WebFetch"]);

type SummaryPart = { text: string; file?: boolean };

/** "Ran 2 commands, created EditGroup.tsx" — what a finished turn did, readable while folded. */
export function traceSummary(
  tools: Extract<WorkItem, { kind: "tool" }>[],
  toolData: Record<string, ToolDetail>,
  endMap: Map<string, ToolEnd>,
  t: Translations["message"],
  notices = 0,
): { phrases: SummaryPart[][]; added: number; removed: number } {
  let ran = 0;
  let read = 0;
  let searched = 0;
  let pages = 0;
  let other = 0;
  const created = new Set<string>();
  const edited = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const it of tools) {
    if (it.name === "Bash") ran++;
    else if (READ_TOOLS.has(it.name)) read++;
    else if (SEARCH_TOOLS.has(it.name)) searched++;
    else if (PAGE_TOOLS.has(it.name)) pages++;
    else if (FILE_EDIT_TOOLS.has(it.name) && it.detail) {
      if (it.name === "Write" && !edited.has(it.detail)) created.add(it.detail);
      else if (!created.has(it.detail)) edited.add(it.detail);
      if (toolCompleted(endMap.get(it.id))) {
        added += toolData[it.id]?.added ?? 0;
        removed += toolData[it.id]?.removed ?? 0;
      }
    } else other++;
  }
  const count = (n: number, one: string, many: string): SummaryPart[] | null =>
    n === 0 ? null : [{ text: n === 1 ? one : many.replace("{n}", String(n)) }];
  const files = (set: Set<string>, single: string, many: string): SummaryPart[] | null => {
    if (set.size === 0) return null;
    if (set.size > 1) return [{ text: many.replace("{n}", String(set.size)) }];
    const [before, after = ""] = single.split("{file}");
    return [{ text: before }, { text: basename([...set][0]), file: true }, { text: after }];
  };
  const phrases = [
    count(ran, t.sumRanOne, t.sumRan),
    count(read, t.sumReadOne, t.sumRead),
    count(searched, t.sumSearchOne, t.sumSearch),
    count(pages, t.sumPageOne, t.sumPage),
    count(other, t.sumOtherOne, t.sumOther),
    files(created, t.sumCreated, t.sumCreatedMany),
    files(edited, t.sumEdited, t.sumEditedMany),
    count(notices, t.sumBgDoneOne, t.sumBgDone),
  ].filter((p): p is SummaryPart[] => p !== null);
  // Only the first phrase keeps its capital: "Ran 2 commands, created …".
  phrases.forEach((parts, i) => {
    if (i > 0 && parts[0] && !parts[0].file) parts[0] = { text: parts[0].text.charAt(0).toLocaleLowerCase() + parts[0].text.slice(1) };
  });
  return { phrases, added, removed };
}
