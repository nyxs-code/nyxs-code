import type { PickedElement } from "@/lib/pickedElement";
import type { AttachedFile, PastedSnippet } from "./types";

const MIC_STORAGE_KEY = "nyxs.voice.micDeviceId";

export function loadMicId(): string {
    try {
        return localStorage.getItem(MIC_STORAGE_KEY) ?? "";
    } catch {
        return "";
    }
}

export function saveMicId(id: string): void {
    try {
        if (id) localStorage.setItem(MIC_STORAGE_KEY, id);
        else localStorage.removeItem(MIC_STORAGE_KEY);
    } catch {
        return;
    }
}

/** What was typed in a session and not sent yet. The composer is one component shared by every
 *  session, so without this a half-written message followed you into the next one. */
export interface InputDraft {
    message: string;
    files: AttachedFile[];
    pastedContent: PastedSnippet[];
    elements: PickedElement[];
}

const DRAFTS_STORAGE_KEY = "nyxs.inputDrafts";
const drafts = new Map<string, InputDraft>();

/** Only the text survives a reload (sessionStorage); files and picks live in memory. */
function storedDraftTexts(): Record<string, string> {
    try {
        const raw = sessionStorage.getItem(DRAFTS_STORAGE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
        return {};
    }
}

export function loadDraft(key: string): InputDraft | null {
    const kept = drafts.get(key);
    if (kept) return kept;
    const text = storedDraftTexts()[key];
    return typeof text === "string" && text ? { message: text, files: [], pastedContent: [], elements: [] } : null;
}

export function saveDraft(key: string, draft: InputDraft): void {
    const empty = !draft.message && !draft.files.length && !draft.pastedContent.length && !draft.elements.length;
    if (empty) drafts.delete(key);
    else drafts.set(key, draft);
    try {
        const texts = storedDraftTexts();
        if (draft.message) texts[key] = draft.message;
        else delete texts[key];
        sessionStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(texts));
    } catch { /* storage full or unavailable: the in-memory draft still holds */ }
}
