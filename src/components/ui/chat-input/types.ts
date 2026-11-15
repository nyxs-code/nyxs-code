import type { PickedElement } from "@/lib/pickedElement";

export interface AttachedFile {
    id: string;
    file: File;
    type: string;
    preview: string | null;
    uploadStatus: string;
}

export interface PastedSnippet {
    id: string;
    content: string;
    timestamp: Date;
}

export interface Model {
    id: string;
    name: string;
    description: string;
    badge?: string;
    context?: number;
    logo?: string;
    logoMono?: boolean;
    /** Where the model comes from: the model menu groups by it. */
    provider?: string;
    providerName?: string;
    providerLogo?: string;
    providerLogoMono?: boolean;
}

export type PermissionMode = "ask" | "acceptEdits" | "plan" | "auto" | "skip";

export interface SendPayload {
    message: string;
    files: AttachedFile[];
    pastedContent: PastedSnippet[];
    model: string;
    isThinkingEnabled: boolean;
    elements?: PickedElement[];
}

export interface SessionUsage {
    inputTokens: number;
    outputTokens: number;
    readTokens: number;
    costUsd: number;
}
