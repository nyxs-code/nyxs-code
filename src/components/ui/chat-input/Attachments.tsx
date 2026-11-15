import { releasePreviews } from "@/lib/attachmentPreviews";
import React, { useState } from "react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { ElementChip } from "@/components/ui/element-chip";
import type { PickedElement } from "@/lib/pickedElement";
import { useTranslations } from "@/lib/i18n";
import { formatFileSize } from "@/lib/fileAttachments";
import { Icons } from "./icons";
import type { AttachedFile, PastedSnippet } from "./types";

const FilePreviewCard: React.FC<{ file: AttachedFile; onRemove: (id: string) => void }> = ({ file, onRemove }) => {
    const isImage = file.type.startsWith("image/") && file.preview;
    const [viewing, setViewing] = useState(false);
    return (
        <div className="relative group flex-shrink-0 w-24 h-24 rounded-[8px] overflow-hidden border border-bg-300 bg-bg-200 animate-fade-in transition-all hover:border-text-400">
            {isImage ? (
                <button type="button" onClick={() => setViewing(true)} className="w-full h-full relative block cursor-zoom-in">
                    <img src={file.preview!} alt={file.file.name} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/20 group-hover:bg-black/0 transition-colors" />
                </button>
            ) : (
                <div className="w-full h-full p-3 flex flex-col justify-between">
                    <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-bg-300 rounded">
                            <Icons.FileText className="w-4 h-4 text-text-300" />
                        </div>
                        <span className="text-[10px] font-medium text-text-400 uppercase tracking-wider truncate">
                            {file.file.name.split(".").pop()}
                        </span>
                    </div>
                    <div className="space-y-0.5">
                        <p className="text-xs font-medium text-text-200 truncate" data-tooltip={file.file.name}>{file.file.name}</p>
                        <p className="text-[10px] text-text-500">{formatFileSize(file.file.size)}</p>
                    </div>
                </div>
            )}
            <button onClick={() => onRemove(file.id)} className="absolute top-1 right-1 p-1 bg-black/50 hover:bg-black/70 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity">
                <Icons.X className="w-3 h-3" />
            </button>
            {file.uploadStatus === "uploading" && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <Icons.Loader2 className="w-5 h-5 text-white animate-spin" />
                </div>
            )}
            {viewing && isImage && <ImageLightbox src={file.preview!} alt={file.file.name} onClose={() => setViewing(false)} />}
        </div>
    );
};

const PastedContentCard: React.FC<{ content: PastedSnippet; onRemove: (id: string) => void }> = ({ content, onRemove }) => {
    const tx = useTranslations().chatInputExtra;
    return (
    <div className="relative group flex-shrink-0 w-28 h-28 rounded-[8px] overflow-hidden border border-[#E5E5E5] dark:border-[#30302E] bg-white dark:bg-[#20201F] animate-fade-in p-3 flex flex-col justify-between shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
        <div className="overflow-hidden w-full">
            <p className="text-[10px] text-[#9CA3AF] leading-[1.4] font-mono break-words whitespace-pre-wrap line-clamp-4 select-none">{content.content}</p>
        </div>
        <div className="flex items-center justify-between w-full mt-2">
            <div className="inline-flex items-center justify-center px-1.5 py-[2px] rounded border border-[#E5E5E5] dark:border-[#404040] bg-white dark:bg-transparent">
                <span className="text-[9px] font-bold text-[#6B7280] dark:text-[#9CA3AF] uppercase tracking-wider font-sans">{tx.pasted}</span>
            </div>
        </div>
        <button onClick={() => onRemove(content.id)} className="absolute top-2 right-2 p-[3px] bg-white dark:bg-[#30302E] border border-[#E5E5E5] dark:border-[#404040] rounded-full text-[#9CA3AF] hover:text-[#6B7280] dark:hover:text-white transition-colors shadow-sm opacity-0 group-hover:opacity-100">
            <Icons.X className="w-2 h-2" />
        </button>
    </div>
    );
};

/** The picked elements, pasted snippets and files that go out with the next message. */
export const ComposerAttachments: React.FC<{
    attachedElements: PickedElement[];
    setAttachedElements: React.Dispatch<React.SetStateAction<PickedElement[]>>;
    files: AttachedFile[];
    setFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>;
    pastedContent: PastedSnippet[];
    setPastedContent: React.Dispatch<React.SetStateAction<PastedSnippet[]>>;
}> = ({ attachedElements, setAttachedElements, files, setFiles, pastedContent, setPastedContent }) => (
    <>
        {attachedElements.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
                {attachedElements.map((el, i) => (
                    <ElementChip
                        key={el.uid ?? `${el.selector}-${i}`}
                        element={el}
                        onRemove={() => setAttachedElements((prev) => prev.filter((e) => e !== el))}
                    />
                ))}
            </div>
        )}
        {(files.length > 0 || pastedContent.length > 0) && (
            <div className="flex gap-3 overflow-x-auto custom-scrollbar pb-2 px-1">
                {pastedContent.map((content) => (
                    <PastedContentCard key={content.id} content={content} onRemove={(id) => setPastedContent((prev) => prev.filter((c) => c.id !== id))} />
                ))}
                {files.map((file) => (
                    <FilePreviewCard
                        key={file.id}
                        file={file}
                        onRemove={(id) => {
                            // Nothing else holds a thumbnail taken off the box (a sent or queued
                            // message keeps its own until it goes), so its memory can go now.
                            releasePreviews([file]);
                            setFiles((prev) => prev.filter((f) => f.id !== id));
                        }}
                    />
                ))}
            </div>
        )}
    </>
);
