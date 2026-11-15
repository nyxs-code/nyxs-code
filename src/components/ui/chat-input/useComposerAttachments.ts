import React, { useState, useRef, useEffect, useCallback } from "react";
import { focusInWebview } from "@/lib/webviewFocus";
import type { AttachedFile, PastedSnippet } from "./types";

interface ComposerAttachmentsOptions {
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    setFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>;
    setPastedContent: React.Dispatch<React.SetStateAction<PastedSnippet[]>>;
    /** Lets others attach files, e.g. the browser's annotated screenshot. */
    attachFilesRef?: React.RefObject<((files: File[]) => void) | null>;
    /** Files dropped anywhere on the window land here. Off for a composer that isn't the
     *  focused one (split view), so a drop doesn't attach to both. */
    primary?: boolean;
}

/** Adding files to the message: the file picker, dropping on the window, pasting, and `attachFilesRef`. */
export function useComposerAttachments({ textareaRef, setFiles, setPastedContent, attachFilesRef, primary = true }: ComposerAttachmentsOptions) {
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const focusComposer = useCallback(() => focusInWebview(textareaRef.current), [textareaRef]);

    const pickFiles = () => {
        window.addEventListener("focus", () => setTimeout(() => void focusComposer(), 0), { once: true });
        fileInputRef.current?.click();
    };

    const handleFiles = useCallback((newFilesList: FileList | File[]) => {
        const newFiles: AttachedFile[] = Array.from(newFilesList).map((file) => {
            const isImage = file.type.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name);
            return {
                id: Math.random().toString(36).slice(2, 11),
                file,
                type: isImage ? "image/unknown" : file.type || "application/octet-stream",
                preview: isImage ? URL.createObjectURL(file) : null,
                uploadStatus: "complete",
            };
        });
        setFiles((prev) => [...prev, ...newFiles]);
    }, [setFiles]);

    useEffect(() => {
        if (!attachFilesRef) return;
        attachFilesRef.current = (list: File[]) => {
            handleFiles(list);
            textareaRef.current?.focus();
        };
        return () => { attachFilesRef.current = null; };
    }, [attachFilesRef, handleFiles, textareaRef]);

    useEffect(() => {
        if (!primary) return;
        let depth = 0;
        const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
        const onEnter = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth++;
            setIsDragging(true);
        };
        const onOver = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        };
        const onLeave = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) setIsDragging(false);
        };
        const onDrop = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth = 0;
            setIsDragging(false);
            const dropped = e.dataTransfer?.files;
            if (dropped && dropped.length > 0) {
                handleFiles(dropped);
                setTimeout(() => void focusComposer(), 0);
            }
        };
        window.addEventListener("dragenter", onEnter);
        window.addEventListener("dragover", onOver);
        window.addEventListener("dragleave", onLeave);
        window.addEventListener("drop", onDrop);
        return () => {
            window.removeEventListener("dragenter", onEnter);
            window.removeEventListener("dragover", onOver);
            window.removeEventListener("dragleave", onLeave);
            window.removeEventListener("drop", onDrop);
        };
    }, [handleFiles, focusComposer, primary]);

    const handlePaste = (e: React.ClipboardEvent) => {
        const items = e.clipboardData.items;
        const pastedFiles: File[] = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === "file") {
                const file = items[i].getAsFile();
                if (file) pastedFiles.push(file);
            }
        }
        if (pastedFiles.length > 0) {
            e.preventDefault();
            handleFiles(pastedFiles);
            return;
        }
        const text = e.clipboardData.getData("text");
        if (text.length > 300) {
            e.preventDefault();
            setPastedContent((prev) => [...prev, { id: Math.random().toString(36).slice(2, 11), content: text, timestamp: new Date() }]);
        }
    };

    return { isDragging, fileInputRef, focusComposer, pickFiles, handleFiles, handlePaste };
}
