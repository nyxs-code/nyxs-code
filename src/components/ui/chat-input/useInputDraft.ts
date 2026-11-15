import { useState, useRef, useEffect } from "react";
import type { PickedElement } from "@/lib/pickedElement";
import type { AttachedFile, PastedSnippet } from "./types";
import { loadDraft, saveDraft, type InputDraft } from "./storage";

/** The unsent message, files, pasted snippets and picked elements of the session `draftKey` names. */
export function useInputDraft(draftKey: string) {
    const [message, setMessage] = useState(() => loadDraft(draftKey)?.message ?? "");
    const [files, setFiles] = useState<AttachedFile[]>(() => loadDraft(draftKey)?.files ?? []);
    const [pastedContent, setPastedContent] = useState<PastedSnippet[]>(() => loadDraft(draftKey)?.pastedContent ?? []);
    const [attachedElements, setAttachedElements] = useState<PickedElement[]>(() => loadDraft(draftKey)?.elements ?? []);

    // Switching sessions files the draft away under the one being left and brings back the
    // other's. Unmounting (new chat ↔ open chat use different composers) files it too.
    const draftRef = useRef<InputDraft>({ message, files, pastedContent, elements: attachedElements });
    const draftKeyRef = useRef(draftKey);
    useEffect(() => {
        if (draftKeyRef.current === draftKey) return;
        saveDraft(draftKeyRef.current, draftRef.current);
        draftKeyRef.current = draftKey;
        const next = loadDraft(draftKey);
        setMessage(next?.message ?? "");
        setFiles(next?.files ?? []);
        setPastedContent(next?.pastedContent ?? []);
        setAttachedElements(next?.elements ?? []);
    }, [draftKey]);
    useEffect(() => () => saveDraft(draftKeyRef.current, draftRef.current), []);
    // Saved as it changes, so a reload without switching keeps the text too.
    useEffect(() => {
        draftRef.current = { message, files, pastedContent, elements: attachedElements };
        saveDraft(draftKeyRef.current, draftRef.current);
    }, [message, files, pastedContent, attachedElements]);
    return { message, setMessage, files, setFiles, pastedContent, setPastedContent, attachedElements, setAttachedElements };
}
