import { stripPrCreatedTags } from "@/lib/prCreatedTag";

export type Segment =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string; /** False while the fence is still being written. */ closed: boolean }
  | { type: "tool"; id: string; name: string; detail: string }
  | { type: "reasoning"; id: string }
  | { type: "todo" }
  | { type: "plan" };

/** "stopped": cut off by a stop before it reported back, which is neither a result nor a failure. */
export type ToolEnd = { status: "ok" } | { status: "err"; message: string } | { status: "stopped" };

/** Whether a tool's result can be counted: it neither failed nor was cut off. */
export function toolCompleted(end: ToolEnd | undefined): boolean {
  return end?.status !== "err" && end?.status !== "stopped";
}

const END_TOKEN =
  /⟦TOOLEND⟧([^⟦]*?)⟦SEP⟧(ok|err|stop)(?:⟦SEP⟧([\s\S]*?))?⟦\/TOOLEND⟧/g;
// A fence closes with as many backticks as it opened with, so a ````markdown block can show a
// ``` one inside it.
const TOKEN =
  /(`{3,})(\w*)\n?([\s\S]*?)\1(?!`)|⟦TOOL⟧([^⟦]*?)⟦SEP⟧([\s\S]*?)⟦SEP⟧([\s\S]*?)⟦\/TOOL⟧|⟦TODO⟧|⟦PLAN⟧|⟦REASONING⟧([^⟦]*?)⟦\/REASONING⟧/g;

export function parseMessage(text: string): { segments: Segment[]; endMap: Map<string, ToolEnd> } {
  const endMap = new Map<string, ToolEnd>();
  let e: RegExpExecArray | null;
  END_TOKEN.lastIndex = 0;
  while ((e = END_TOKEN.exec(text)) !== null) {
    endMap.set(e[1], e[2] === "err" ? { status: "err", message: e[3] ?? "" } : e[2] === "stop" ? { status: "stopped" } : { status: "ok" });
  }
  const stripped = text.replace(END_TOKEN, "");

  const segments: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(stripped)) !== null) {
    if (m.index > last) segments.push({ type: "text", content: stripped.slice(last, m.index) });
    if (m[0].startsWith("```")) {
      segments.push({ type: "code", lang: m[2] || "code", content: m[3].replace(/\n$/, ""), closed: true });
    } else if (m[0] === "⟦TODO⟧") {
      segments.push({ type: "todo" });
    } else if (m[0] === "⟦PLAN⟧") {
      segments.push({ type: "plan" });
    } else if (m[7] !== undefined) {
      segments.push({ type: "reasoning", id: m[7] });
    } else {
      segments.push({ type: "tool", id: m[4], name: m[5], detail: m[6] ?? "" });
    }
    last = TOKEN.lastIndex;
  }
  if (last < stripped.length) {
    const tail = stripped.slice(last);
    const open = /`{3,}(\w*)[ \t]*\n?/.exec(tail);
    if (open) {
      const before = tail.slice(0, open.index);
      if (before) segments.push({ type: "text", content: before });
      segments.push({ type: "code", lang: open[1] || "code", content: tail.slice(open.index + open[0].length), closed: false });
    } else {
      segments.push({ type: "text", content: tail });
    }
  }

  for (const seg of segments) {
    if (seg.type === "text") {
      // `<pr-created>` is for Nyxs (it links the PR to the session), not for the reader.
      seg.content = stripPrCreatedTags(
        seg.content
          .replace(/<(mm:)?think>[\s\S]*?<\/(mm:)?think>/gi, "")
          .replace(/<\/?(mm:)?think>/gi, ""),
      );
    }
  }

  return { segments, endMap };
}
