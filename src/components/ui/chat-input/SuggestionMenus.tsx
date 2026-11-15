import React, { useState, useRef, useLayoutEffect } from "react";
import { FileText } from "lucide-react";
import type { SlashCommand } from "@/lib/slashCommand";

/** The `/` command list; hovering a row shows its description beside it. */
export const SlashMenu: React.FC<{
    slashItems: SlashCommand[];
    slashIndex: number;
    setSlashIndex: (i: number) => void;
    slashHovering: boolean;
    setSlashHovering: (on: boolean) => void;
    selectSlash: (name: string) => void;
}> = ({ slashItems, slashIndex, setSlashIndex, slashHovering, setSlashHovering, selectSlash }) => {
    const slashWrapRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);
    const activeRowRef = useRef<HTMLButtonElement | null>(null);
    const [slashTipTop, setSlashTipTop] = useState(0);
    const showTip = slashHovering && !!slashItems[slashIndex]?.description;
    useLayoutEffect(() => {
        const row = activeRowRef.current;
        const list = listRef.current;
        const wrap = slashWrapRef.current;
        if (!row || !list || !wrap) return;
        // Only the list scrolls to the row: scrollIntoView would also move the chat behind the menu.
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
        // Beside the row, but never past the menu's bottom: below it sit the chat box and the window's edge.
        const rowTop = row.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
        const tipHeight = tipRef.current?.offsetHeight ?? 0;
        setSlashTipTop(Math.max(0, Math.min(rowTop, wrap.offsetHeight - tipHeight)));
    }, [slashIndex, slashItems, showTip]);
    return (
        <div ref={slashWrapRef} data-composer-menu className="absolute bottom-full left-0 mb-1.5 z-30">
            <div
                ref={listRef}
                className="relative w-56 max-h-72 overflow-y-auto custom-scrollbar rounded-[8px] border border-bg-300 bg-bg-100 shadow-lg py-1"
                onMouseLeave={() => setSlashHovering(false)}
            >
                {slashItems.map((cmd, i) => (
                    <button
                        key={cmd.name}
                        type="button"
                        ref={i === slashIndex ? (el) => { activeRowRef.current = el; } : undefined}
                        onMouseDown={(e) => { e.preventDefault(); selectSlash(cmd.name); }}
                        onMouseEnter={() => { setSlashIndex(i); setSlashHovering(true); }}
                        className={`w-full text-left px-3 py-1.5 text-[13px] truncate ${i === slashIndex ? "bg-bg-300 text-text-100" : "text-text-200 hover:bg-bg-200"}`}
                    >
                        {cmd.name}
                    </button>
                ))}
            </div>
            {showTip && (
                <div
                    ref={tipRef}
                    className="absolute left-[14.25rem] w-64 max-h-72 overflow-y-auto custom-scrollbar rounded-[8px] border border-bg-300 bg-bg-100 shadow-lg px-3 py-2 text-[12px] leading-snug text-text-300"
                    style={{ top: slashTipTop }}
                >
                    {slashItems[slashIndex].description}
                </div>
            )}
        </div>
    );
};

/** The `@` file list. */
export const MentionMenu: React.FC<{
    mentionItems: string[];
    mentionIndex: number;
    setMentionIndex: (i: number) => void;
    selectMention: (path: string) => void;
}> = ({ mentionItems, mentionIndex, setMentionIndex, selectMention }) => (
    <div className="absolute bottom-full left-0 right-0 mb-1.5 z-30 max-h-72 overflow-y-auto custom-scrollbar rounded-[8px] border border-bg-300 bg-bg-100 shadow-lg py-1">
        {mentionItems.map((path, i) => (
            <button
                key={path}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); selectMention(path); }}
                onMouseEnter={() => setMentionIndex(i)}
                className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-[13px] ${i === mentionIndex ? "bg-bg-300 text-text-100" : "text-text-200 hover:bg-bg-200"}`}
            >
                <FileText className="w-3.5 h-3.5 shrink-0 text-accent" />
                <span className="truncate font-mono">{path}</span>
            </button>
        ))}
    </div>
);
