import { CloudError, deleteCloudThread } from "@/lib/cloud/cloudApi";
import type { ProjectSessionFields } from "./types";

/** The cloud threads behind these sessions, if any. */
export function cloudThreadIdsOf(sessions: Pick<ProjectSessionFields, "threadLocation">[]): string[] {
  return [...new Set(sessions.flatMap((s) => (s.threadLocation?.kind === "cloud" ? [s.threadLocation.cloudThreadId] : [])))];
}

/**
 * Deletes the cloud threads of sessions about to be deleted, with their data on Nyxs's servers.
 * Runs before the sessions go: when the cloud refuses, the caller keeps them, so the user isn't
 * left with data in the cloud and nothing here to delete it from. One already gone (404) counts
 * as deleted. Returns the error to show, or null.
 */
export async function deleteCloudCopies(sessions: Pick<ProjectSessionFields, "threadLocation">[]): Promise<string | null> {
  for (const id of cloudThreadIdsOf(sessions)) {
    try {
      await deleteCloudThread(id);
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) continue;
      return e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}
