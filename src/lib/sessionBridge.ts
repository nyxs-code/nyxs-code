import type { Chat } from "@/lib/chatStore";
import type { ChatMessage } from "@/components/Message";

/** What the agent can do with the user's other sessions, like Claude Code Desktop: list, read,
 *  message, rename and archive them. The app fills this in (it holds the sessions); the tools in
 *  src/tools/Sessions use it. */
export interface SessionInfo {
  id: string;
  title: string;
  /** The project folder's name. */
  project: string;
  modifiedAt: number;
  /** It's the session the agent is running in. */
  current: boolean;
  /** A turn is running there right now. */
  working: boolean;
}

export type SendOutcome = "sent" | "queued" | "missing" | "unsupported";

export interface CreateSessionRequest {
  title: string;
  /** Its first message, which starts its first turn. */
  message: string;
  /** A model, by id or name; the parent's model when unset. */
  model?: string;
  /** An effort level; the parent's effort when unset. */
  effort?: string;
  /** Hand its first reply back to the session that created it, as a message there. */
  reportBack: boolean;
  /** Fields of the new session worked out once its id is known, before it's saved and its first
   *  turn starts (a project thread's worktree and project fields). */
  prepare?: (id: string, workspace: string) => Promise<Partial<Chat>>;
  /** The folder it works in, instead of its parent's (a project's folder, when its coordinator
   *  works elsewhere). */
  workspace?: string;
}

export interface SendOptions {
  /** The line above the quoted text, instead of "Message from the session …". */
  header?: string;
  /** More fields of the message (how its card shows). */
  message?: Partial<ChatMessage>;
  /** Only adds the message to the conversation: no turn runs on it. */
  quiet?: boolean;
}

export type CreateOutcome =
  | { id: string; model: string; effort: string }
  | "unsupported"
  | "no-project"
  /** No model fits the name asked for: these are the ones it can run on. */
  | { unknownModel: string[] }
  | { unknownEffort: string[] };

export interface SessionBridge {
  /** Starts a new session nested under `fromId` (in its project, with its model unless told
   *  otherwise) and sends it its first message. */
  create(fromId: string | undefined, request: CreateSessionRequest): Promise<CreateOutcome>;
  list(currentId: string | undefined): SessionInfo[];
  read(id: string, last: number): Promise<{ title: string; messages: { role: string; content: string }[] } | null>;
  /** Delivers `text` as a message in the session, attributed to `fromId`, and starts its turn
   *  (right away, or once its running turn ends). */
  send(fromId: string | undefined, id: string, text: string, opts?: SendOptions): Promise<SendOutcome>;
  rename(id: string, title: string): Promise<boolean>;
  archive(id: string): Promise<boolean>;
}

let bridge: SessionBridge | null = null;
export const setSessionBridge = (b: SessionBridge | null) => {
  bridge = b;
};
export const sessionBridge = () => bridge;

/** How a message from another session shows in the one it's sent to: who sent it, then the
 *  text quoted. */
export function attributedMessage(header: string, text: string): string {
  return `${header}\n\n${text.trim().split("\n").map((l) => `> ${l}`).join("\n")}`;
}

const MAX_REPORT = 6000;

/** What a session created with CreateSession hands back to its parent after its first turn. */
export function reportMessage(title: string, id: string, reply: string): string {
  const text = reply.trim() || "(it ended its turn without a reply)";
  const clipped = text.length > MAX_REPORT ? `${text.slice(0, MAX_REPORT)}\n… (cut; read the session for the rest)` : text;
  return attributedMessage(`Reply from the session "${title}" (${id}), which you created:`, clipped);
}
