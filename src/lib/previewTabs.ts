import { classifyAddress } from "@/components/views/preview/addressInput";
import { isProjectTarget, sameServer } from "@/components/views/preview/helpers";
import type { PreviewPageInfo } from "@/lib/previewControl";

/** A tab of a chat's browser, as the choice of where to open an address sees it. */
export interface BrowserTabInfo {
  id: string;
  page: PreviewPageInfo;
  front: boolean;
  /** The agent opened it, and the user hasn't taken it over by opening an address in it. */
  agent: boolean;
}

/**
 * The tab where the agent should open `address`, or null for a new one. The agent tests the
 * project in the tab already showing it, and keeps anything else to a tab of its own: the user's
 * pages (a video, their mail) and the project's page are never replaced by what it looks up.
 */
export function pickAgentTab(address: string, tabs: BrowserTabInfo[], workspace: string | null, pinned?: string | null): string | null {
  const frontFirst = [...tabs].sort((a, b) => Number(b.front) - Number(a.front));
  const showsProject = (tab: BrowserTabInfo) => isProjectTarget(tab.page.url, workspace);
  if (isProjectTarget(address, workspace)) {
    const project = frontFirst.filter(showsProject);
    const target = classifyAddress(address);
    const url = target.kind === "web" ? target.url : address;
    const tab = project.find((t) => sameServer(t.page.url, url)) ?? project[0];
    if (tab) return tab.id;
  }
  const own = frontFirst.filter((tab) => tab.agent && !showsProject(tab));
  const mine = own.find((tab) => tab.id === pinned) ?? own[0];
  if (mine) return mine.id;
  return frontFirst.find((tab) => tab.page.kind === "empty")?.id ?? null;
}
