import React, { useState, useRef, useEffect, useCallback } from "react";
import { getAtToken, applyAtSuggestion, rankFiles, type AtToken } from "@/lib/fileMention";
import { COMPOSER_INSERT_EVENT } from "@/lib/filePaths";
import { focusInWebview } from "@/lib/webviewFocus";
import { getSlashToken, applySlashSuggestion, rankCommands, type SlashToken, type SlashCommand } from "@/lib/slashCommand";
import { isComposingKey } from "@/lib/imeKeys";

interface ComposerSuggestionsOptions {
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    setMessage: React.Dispatch<React.SetStateAction<string>>;
    /** Where the caret goes once the picked suggestion is in the box. */
    pendingCursorRef: React.RefObject<number | null>;
    workspace?: string | null;
    onListFiles?: () => Promise<string[]>;
    commands: SlashCommand[];
    /** "Attach as context" lands here; off for the unfocused pane of a split view. */
    primary?: boolean;
}

/** The `@` file and `/` command suggestions for the word at the caret, and their keys. */
export function useComposerSuggestions({ textareaRef, setMessage, pendingCursorRef, workspace, onListFiles, commands, primary = true }: ComposerSuggestionsOptions) {
    const [mentionOpen, setMentionOpen] = useState(false);
    const [mentionItems, setMentionItems] = useState<string[]>([]);
    const [mentionIndex, setMentionIndex] = useState(0);
    const mentionTokenRef = useRef<AtToken | null>(null);
    const fileListRef = useRef<string[] | null>(null);

    useEffect(() => { fileListRef.current = null; }, [workspace]);

    // "Attach as context" on a file path in the chat: its `@mention` goes in at the caret.
    useEffect(() => {
        if (!primary) return;
        const onInsert = (e: Event) => {
            const text = (e as CustomEvent<string>).detail;
            const ta = textareaRef.current;
            if (!text || !ta?.offsetParent) return;
            const at = ta.selectionStart ?? ta.value.length;
            const before = ta.value.slice(0, at);
            const piece = before && !/\s$/.test(before) ? ` ${text}` : text;
            setMessage(before + piece + ta.value.slice(ta.selectionEnd ?? at));
            pendingCursorRef.current = at + piece.length;
            void focusInWebview(ta);
        };
        window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
        return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
    }, [textareaRef, setMessage, pendingCursorRef, primary]);

    const refreshMentions = useCallback(async (value: string, cursor: number) => {
        const token = getAtToken(value, cursor);
        if (!token || !onListFiles) {
            mentionTokenRef.current = null;
            setMentionOpen(false);
            return;
        }
        // A new `@` lists the files again: ones created since the last one must show up.
        if (mentionTokenRef.current == null) fileListRef.current = null;
        mentionTokenRef.current = token;
        if (fileListRef.current == null) {
            try {
                fileListRef.current = await onListFiles();
            } catch {
                fileListRef.current = [];
            }
            const fresh = textareaRef.current
                ? getAtToken(textareaRef.current.value, textareaRef.current.selectionStart ?? 0)
                : null;
            if (!fresh) { setMentionOpen(false); return; }
            mentionTokenRef.current = fresh;
        }
        const items = rankFiles(fileListRef.current ?? [], mentionTokenRef.current.query);
        setMentionItems(items);
        setMentionIndex(0);
        setMentionOpen(items.length > 0);
    }, [onListFiles, textareaRef]);

    const selectMention = useCallback((filePath: string) => {
        const token = mentionTokenRef.current;
        const ta = textareaRef.current;
        if (!token || !ta) return;
        const { value, cursor } = applyAtSuggestion(ta.value, ta.selectionStart ?? ta.value.length, token, filePath);
        setMessage(value);
        pendingCursorRef.current = cursor;
        mentionTokenRef.current = null;
        setMentionOpen(false);
    }, [textareaRef, setMessage, pendingCursorRef]);

    const [slashOpen, setSlashOpen] = useState(false);
    const [slashItems, setSlashItems] = useState<SlashCommand[]>([]);
    const [slashIndex, setSlashIndex] = useState(0);
    const [slashHovering, setSlashHovering] = useState(false);
    const slashTokenRef = useRef<SlashToken | null>(null);

    const refreshSlash = useCallback((value: string, cursor: number) => {
        const token = commands.length ? getSlashToken(value, cursor) : null;
        if (!token) {
            slashTokenRef.current = null;
            setSlashOpen(false);
            return;
        }
        slashTokenRef.current = token;
        const items = rankCommands(commands, token.query);
        setSlashItems(items);
        setSlashIndex(0);
        setSlashHovering(false);
        setSlashOpen(items.length > 0);
    }, [commands]);

    const selectSlash = useCallback((name: string) => {
        const token = slashTokenRef.current;
        const ta = textareaRef.current;
        if (!token || !ta) return;
        const { value, cursor } = applySlashSuggestion(ta.value, ta.selectionStart ?? ta.value.length, token, name);
        setMessage(value);
        pendingCursorRef.current = cursor;
        slashTokenRef.current = null;
        setSlashOpen(false);
    }, [textareaRef, setMessage, pendingCursorRef]);

    const refreshSuggestions = useCallback((value: string, cursor: number) => {
        refreshMentions(value, cursor);
        refreshSlash(value, cursor);
    }, [refreshMentions, refreshSlash]);

    /** Arrow keys, Enter/Tab and Escape while a menu is open; true when the key was used. */
    const handleMenuKey = (e: React.KeyboardEvent): boolean => {
        if (isComposingKey(e)) return false;
        if (slashOpen && slashItems.length > 0) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((i) => (i + 1) % slashItems.length);
                return true;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
                return true;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                selectSlash(slashItems[slashIndex].name);
                return true;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                setSlashOpen(false);
                return true;
            }
        }
        if (mentionOpen && mentionItems.length > 0) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionItems.length);
                return true;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
                return true;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                selectMention(mentionItems[mentionIndex]);
                return true;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                setMentionOpen(false);
                return true;
            }
        }
        return false;
    };

    return {
        mentionOpen, setMentionOpen, mentionItems, mentionIndex, setMentionIndex, selectMention,
        slashOpen, setSlashOpen, slashItems, slashIndex, setSlashIndex, slashHovering, setSlashHovering, selectSlash,
        refreshSuggestions, handleMenuKey,
    };
}
