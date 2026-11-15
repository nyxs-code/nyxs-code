import { useEffect } from "react";
import { discardSavedReview, type ReviewSet } from "./store";

/**
 * The hunk-by-hunk review (`ReviewStore`) has no UI yet, so turns don't track their edits for it
 * and nothing reads or watches files for it. Opening a chat only deletes what older versions
 * saved for it in `review/<session>.json` (the original text of every file a turn touched).
 */
export function useReviewSync(chatId: string | null, workspace: string | null): ReviewSet | undefined {
  useEffect(() => {
    if (chatId && workspace) void discardSavedReview(workspace, chatId);
  }, [chatId, workspace]);
  return undefined;
}
