import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { isComposingKey } from "@/lib/imeKeys";
import {
  clearHighlights,
  collectRanges,
  paintHighlights,
  rangesStale,
  revealRange,
  wrapIndex,
} from "@/lib/findInPage";

interface FindBarProps {
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Told what is searched before the search runs, so the chat can draw older messages that
   *  hold it: only what is drawn can be found. */
  onQuery?: (query: string) => void;
}

export default function FindBar({ containerRef, onClose, onQuery }: FindBarProps) {
  const t = useTranslations().search;
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);

  const run = useCallback(
    (text: string, at: number) => {
      const root = containerRef.current;
      const ranges = root ? collectRanges(root, text) : [];
      rangesRef.current = ranges;
      const next = wrapIndex(at, ranges.length);
      setTotal(ranges.length);
      setIndex(next);
      paintHighlights(ranges, next);
      revealRange(ranges[next]);
    },
    [containerRef],
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return clearHighlights;
  }, []);

  useEffect(() => {
    run(query, 0);
  }, [query, run]);

  const step = (delta: number) => {
    if (rangesStale(rangesRef.current)) {
      run(query, index + delta);
      return;
    }
    const next = wrapIndex(index + delta, rangesRef.current.length);
    setIndex(next);
    paintHighlights(rangesRef.current, next);
    revealRange(rangesRef.current[next]);
  };

  const status = !query ? "" : total === 0 ? t.findNoResults : `${index + 1}/${total}`;

  return (
    <div className="flex items-center gap-1 rounded-lg border border-bg-300 bg-bg-100 px-2 py-1 mr-2" data-find-ignore>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          onQuery?.(e.target.value);
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isComposingKey(e)) {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={t.findPlaceholder}
        className="w-48 bg-transparent text-sm text-text-100 placeholder:text-text-400 outline-none"
      />
      <span className="min-w-[3.5rem] text-right text-xs tabular-nums text-text-400">{status}</span>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={total === 0}
        aria-label={t.findPrevious}
        className="rounded p-1 text-text-300 hover:bg-bg-200 disabled:opacity-40"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={total === 0}
        aria-label={t.findNext}
        className="rounded p-1 text-text-300 hover:bg-bg-200 disabled:opacity-40"
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t.findClose}
        className="rounded p-1 text-text-300 hover:bg-bg-200"
      >
        <X size={14} />
      </button>
    </div>
  );
}
