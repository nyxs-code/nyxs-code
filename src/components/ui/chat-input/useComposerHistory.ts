import { useRef, type KeyboardEvent, type MutableRefObject } from "react";

interface ComposerHistoryOptions {
    /** The messages the user sent in this chat, oldest first. */
    history: readonly string[] | undefined;
    message: string;
    setMessage: (text: string) => void;
    pendingCursorRef: MutableRefObject<number | null>;
    /** Files, pasted text or picked elements wait in the box: the box isn't empty. */
    hasAttachments: boolean;
}

/**
 * ↑ in an empty box brings back the messages sent earlier, newest first, and ↓ goes back toward
 * the empty box, as in a terminal. Nothing is shown about it: the box just holds the message.
 * Typing over a recalled message ends the browsing, so the arrows move the caret again. In a
 * message of several lines the arrows move between its lines and only leave it from the first
 * line (↑) or the last (↓).
 */
export function useComposerHistory({ history, message, setMessage, pendingCursorRef, hasAttachments }: ComposerHistoryOptions) {
    // How far back the box is (0 = the latest message) and the text it put there.
    const browsing = useRef<{ pos: number; shown: string } | null>(null);

    const handleHistoryKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
        if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
        if (browsing.current && browsing.current.shown !== message) browsing.current = null;
        const entries = (history ?? []).filter((text, i, all) => text.trim() && text !== all[i - 1]);
        const current = browsing.current;
        const ta = e.currentTarget;
        const show = (pos: number) => {
            e.preventDefault();
            if (pos < 0) {
                browsing.current = null;
                setMessage("");
                return true;
            }
            const text = entries[entries.length - 1 - pos];
            browsing.current = { pos, shown: text };
            setMessage(text);
            pendingCursorRef.current = text.length;
            return true;
        };
        if (e.key === "ArrowUp") {
            if (!current && (message !== "" || hasAttachments)) return false;
            if (current && ta.value.slice(0, ta.selectionStart).includes("\n")) return false;
            const next = (current?.pos ?? -1) + 1;
            if (next >= entries.length) {
                // At the oldest message ↑ stays put instead of jumping to the start of the text.
                if (current) e.preventDefault();
                return !!current;
            }
            return show(next);
        }
        if (!current || ta.value.slice(ta.selectionEnd).includes("\n")) return false;
        return show(current.pos - 1);
    };

    return { handleHistoryKey };
}
