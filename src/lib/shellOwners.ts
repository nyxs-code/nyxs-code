import { loadReloadState, saveReloadState } from "@/lib/reloadState";

// Which chat's agent started each background shell. Shells are the project's (the Terminal view
// lists them all), but a chat's browser must not react to a server another chat's agent started.

const KEY = "shellOwners";

/** Kept for a reload of the app's page, which the shells outlive. */
const owners: Record<string, string> = loadReloadState<Record<string, string>>(KEY) ?? {};

export function noteShellOwner(shellId: string, chat: string | undefined): void {
  if (!chat) return;
  owners[shellId] = chat;
  saveReloadState(KEY, owners);
}

/** The chat whose agent started the shell; unset for one the user started. */
export function shellOwner(shellId: string): string | undefined {
  return owners[shellId];
}
