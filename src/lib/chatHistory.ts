import type { ChatMessage } from "@/components/Message";
import type { ChatTurn } from "@/lib/ai";
import { stripToolMarkers } from "@/lib/chatMessages";
import { getContinuationMessage } from "@/lib/compact";
import { withDocuments } from "@/lib/fileAttachments";
import { pickedElementsOf, withElementShots, withPickedElements } from "@/lib/pickedElement";
import { withoutOldToolImages } from "@/lib/toolImageHistory";

const REASONING_MARKER = /⟦REASONING⟧[\s\S]*?⟦\/REASONING⟧/g;

export interface ChatHistory {
  history: ChatTurn[];
  /** Where the summary ends, for a compaction during the turn to build on. */
  compaction: { upTo: number; hadSummary: boolean };
  /** The saved summary pointed past the end of the chat (messages were removed), so it was
   *  dropped; the chat should forget it too. */
  summaryDropped: boolean;
}

/** What the model receives of a chat: its summary, if any, then every message after it, with
 *  pasted text, picked page elements and documents folded into the user messages. */
export function chatHistory(messages: ChatMessage[], summary = "", compactedUpTo = 0): ChatHistory {
  const summaryDropped = compactedUpTo > messages.length;
  if (summaryDropped) {
    summary = "";
    compactedUpTo = 0;
  }
  const history: ChatTurn[] = [];
  if (summary) history.push({ role: "user", content: getContinuationMessage(summary) });
  // Only the latest tool screenshots, as the saved chat keeps: the older ones (a few hundred KB
  // each) went to the model on every turn until the context ran short.
  for (const m of withoutOldToolImages(messages).slice(compactedUpTo)) {
    // A notice only for the user (a goal met): nothing for the model.
    if (m.notice && !m.content.trim()) continue;
    if (m.role === "assistant" && m.responseMessages?.length) {
      history.push({ role: "assistant", content: m.content, messages: m.responseMessages });
    } else if (m.role === "assistant") {
      // A reply without the model's own messages (an agent CLI's, or one that failed before any
      // step was kept): its text, without the markers that place the chat's cards.
      history.push({ role: "assistant", content: stripToolMarkers(m.content.replace(REASONING_MARKER, "")), images: m.images });
    } else {
      let content = m.role === "user" && m.pasted?.length ? [m.content, ...m.pasted].filter(Boolean).join("\n\n") : m.content;
      const elements = m.role === "user" ? pickedElementsOf(m) : [];
      content = withPickedElements(content, elements);
      if (m.role === "user") content = withDocuments(content, m.documents);
      history.push({ role: m.role, content, images: m.role === "user" ? withElementShots(m.images, elements) : m.images });
    }
  }
  return { history, compaction: { upTo: compactedUpTo, hadSummary: Boolean(summary) }, summaryDropped };
}
