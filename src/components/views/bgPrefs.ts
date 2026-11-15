import { accountKey } from "@/lib/accountScope";

const KEY = "nyxs.bgFinishedOpen";

function readAll(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(accountKey(KEY)) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function finishedOpenFor(sessionId: string): boolean {
  return readAll()[sessionId] === true;
}

export function rememberFinishedOpen(sessionId: string, open: boolean): void {
  const all = readAll();
  if (open) all[sessionId] = true;
  else delete all[sessionId];
  try {
    localStorage.setItem(accountKey(KEY), JSON.stringify(all));
  } catch {
    return;
  }
}
