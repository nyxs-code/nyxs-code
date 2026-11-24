import type { ReactNode } from "react";

/** Fills a string's {placeholders} with nodes (a branch name in code type, the folder's name). */
export function fill(text: string, values: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    return key && key in values ? <span key={i}>{values[key]}</span> : part;
  });
}

/** A branch name as the branch picker's texts show it. */
export function branchName(name: ReactNode): ReactNode {
  return <code className="font-mono text-[12.5px] font-medium text-text-100 [overflow-wrap:anywhere]">{name}</code>;
}
