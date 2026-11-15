import type { ChatMessage } from "@/components/Message";
import type { SendPayload } from "@/components/ui/claude-style-chat-input";
import type { ImageAttachment } from "@/lib/ai";
import { saveAttachment, toDocumentAttachments, withDocuments } from "@/lib/fileAttachments";
import { toImageAttachments } from "@/lib/imageAttachments";
import { withElementShots, withPickedElements } from "@/lib/pickedElement";

const uid = () => Math.random().toString(36).slice(2, 11);

export interface OutgoingMessage {
  /** The message as the chat shows it. */
  userMessage: ChatMessage;
  /** What the model receives: the text with pasted text, picked elements and documents. */
  modelText: string;
  modelImages: ImageAttachment[] | undefined;
  /** Text to name a new chat after. */
  titleText: string;
}

/** Turns what the chat box sends into the chat message and what the model gets. Null when
 *  there is nothing to send. `shown` replaces the text in the chat (a command's label). */
export async function outgoingMessage(payload: SendPayload, shown?: string): Promise<OutgoingMessage | null> {
  const text = payload.message.trim();
  const pasted = payload.pastedContent.map((p) => p.content);
  const pastedJoined = pasted.join("\n\n");
  const combined = [text, pastedJoined].filter(Boolean).join("\n\n");
  const images = await toImageAttachments(payload.files);
  const documents = await toDocumentAttachments(payload.files, saveAttachment);
  const elements = payload.elements ?? [];
  if (!combined && !images.length && !documents.length && !elements.length) return null;
  const content = shown ?? text;
  return {
    userMessage: {
      id: uid(),
      role: "user",
      content,
      pasted: pasted.length ? pasted : undefined,
      images: images.length ? images : undefined,
      documents: documents.length ? documents : undefined,
      elements: elements.length ? elements : undefined,
      createdAt: Date.now(),
    },
    modelText: withDocuments(withPickedElements(combined, elements), documents),
    modelImages: withElementShots(images.length ? images : undefined, elements),
    titleText: content || pastedJoined || documents[0]?.name || "",
  };
}
