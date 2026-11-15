import { useId } from "react";
import { ArrowLeft, ArrowRight, Check, Globe, RotateCw, Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import type { FeatureSettings } from "@/lib/featureSettings";
import { searchEngineName } from "@/lib/searchEngines";
import { useSettings } from "@/lib/useSettings";
import { CursorIcon } from "@/components/ui/cursor-icon";
import { ACTIVE_TOGGLE } from "@/lib/uiClasses";
import { PICK_SHORTCUT } from "./helpers";
import { PickElementTip } from "./PickElementTip";
import type { AddressSuggestion } from "./addressSuggestions";
import type { useAddressSuggestions } from "./useAddressSuggestions";

type AddressSuggestionsState = ReturnType<typeof useAddressSuggestions>;

const SUGGESTION_ICON = { address: Globe, search: Search, suggestion: Search } as const;

/** The tab's second toolbar row: back, forward, reload, the address and the element picker. */
export function AddressBar({
  canBack,
  canForward,
  step,
  reload,
  input,
  setInput,
  urlFocused,
  setUrlFocused,
  go,
  hist,
  notice,
  picking,
  onTogglePick,
  hasPage,
  pickTipShown,
  setPickTip,
  bookmarked,
  onToggleBookmark,
  suggest,
  onPick,
}: {
  canBack: boolean;
  canForward: boolean;
  step: (delta: number) => void;
  reload: () => void;
  input: string;
  setInput: (v: string) => void;
  urlFocused: boolean;
  setUrlFocused: (focused: boolean) => void;
  go: () => void;
  hist: { list: string[]; i: number };
  notice: string;
  /** Whether the element picker is waiting for a click. */
  picking: boolean;
  onTogglePick: () => void;
  hasPage: boolean;
  pickTipShown: boolean;
  setPickTip: (shown: boolean) => void;
  /** Whether the page shown is in the bookmarks bar. */
  bookmarked: boolean;
  onToggleBookmark: () => void;
  /** The list of suggestions under the address (see useAddressSuggestions). */
  suggest: AddressSuggestionsState;
  onPick: (s: AddressSuggestion) => void;
}) {
  const listId = useId();
  const t = useTranslations().views;
  const browser = (useSettings().settings as FeatureSettings).browser;
  const placeholder = t.urlPlaceholder.replace("{engine}", searchEngineName({ engine: browser?.searchEngine, customUrl: browser?.customSearchUrl }));
  const tNav = useTranslations().titleBar;
  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <button type="button" onClick={() => step(-1)} disabled={!canBack} aria-label={tNav.back} data-tooltip={tNav.back} className="p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-200 shrink-0 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-400">
        <ArrowLeft className="w-4 h-4" />
      </button>
      <button type="button" onClick={() => step(1)} disabled={!canForward} aria-label={tNav.forward} data-tooltip={tNav.forward} className="p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-200 shrink-0 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-400">
        <ArrowRight className="w-4 h-4" />
      </button>
      <button type="button" onClick={reload} aria-label={t.reload} data-tooltip={t.reload} className="p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-200 shrink-0 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-400">
        <RotateCw className="w-3.5 h-3.5" />
      </button>
      <div className="relative flex-1 min-w-0 ml-1">
        <input
          value={urlFocused ? input : input.replace(/^https?:\/\//i, "").replace(/\/$/, "")}
          onChange={(e) => { setInput(e.target.value); suggest.onType(); }}
          onKeyDown={(e) => {
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggest.open) {
              e.preventDefault();
              suggest.move(e.key === "ArrowDown" ? 1 : -1);
              return;
            }
            if (e.key === "Enter") {
              const picked = suggest.items[suggest.active];
              if (picked) onPick(picked);
              else go();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              // The list closes first; a second Escape gives the address back.
              if (suggest.open) { suggest.close(); return; }
              setInput(hist.list[hist.i] ?? "");
              e.currentTarget.blur();
            }
          }}
          onFocus={(e) => {
            // The full address goes in now, not on the next render: rewriting the value after
            // something selected the text (a click, a paste, a test filling it) would drop the
            // selection and glue what's typed onto the old address.
            const el = e.currentTarget;
            if (el.value !== input) el.value = input;
            el.select();
            setUrlFocused(true);
            requestAnimationFrame(() => el.select());
          }}
          onBlur={() => setUrlFocused(false)}
          placeholder={placeholder}
          spellCheck={false}
          aria-label={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggest.open}
          aria-controls={suggest.open ? listId : undefined}
          aria-activedescendant={suggest.active >= 0 ? `${listId}-${suggest.active}` : undefined}
          className="w-full h-7 pl-2.5 pr-8 rounded-md border border-bg-300 bg-bg-100 text-[13px] text-text-100 placeholder:text-text-500 outline-none focus:border-accent transition-colors"
        />
        {suggest.open && (
          // Over the page: a hole in the native webview lets it show.
          <div
            data-mod-menu
            id={listId}
            role="listbox"
            aria-label={t.addressSuggestions}
            data-webview-hole
            className="absolute left-0 right-0 top-full z-50 mt-1 rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg"
          >
            {suggest.items.map((s, i) => {
              const Icon = SUGGESTION_ICON[s.kind];
              return (
                <div
                  key={`${s.kind}:${s.value}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === suggest.active}
                  // Keeps the focus in the address, so picking doesn't close the list first.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => suggest.setActive(i)}
                  onClick={() => { onPick(s); (document.activeElement as HTMLElement | null)?.blur(); }}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1 rounded-[6px] text-[13px] cursor-default",
                    i === suggest.active ? "bg-bg-200 text-text-100" : "text-text-200",
                  )}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0 text-text-400" />
                  <span className="min-w-0 truncate">
                    {s.kind === "search" ? t.suggestSearch.replace("{engine}", s.detail ?? "").replace("{query}", s.label) : s.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {/* Inside the address, at its right end, as Chrome has it. */}
        {hasPage && (
          <button
            type="button"
            onClick={onToggleBookmark}
            aria-label={bookmarked ? t.removeBookmark : t.addBookmark}
            aria-pressed={bookmarked}
            data-tooltip={bookmarked ? t.removeBookmark : t.addBookmark}
            className={cn(
              "absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-[6px]",
              bookmarked ? "text-accent hover:bg-bg-200" : "text-text-400 hover:text-text-100 hover:bg-bg-200",
            )}
          >
            <Star className="w-3.5 h-3.5" fill={bookmarked ? "currentColor" : "none"} />
          </button>
        )}
        {notice && (
          <div role="status" className="absolute inset-0 flex items-center justify-center gap-1.5 px-2.5 rounded-md border border-bg-300 bg-bg-100 text-[12.5px] text-text-200 pointer-events-none animate-fade-in">
            <Check className="w-3.5 h-3.5 shrink-0 text-accent" />
            <span className="truncate">{notice}</span>
          </div>
        )}
      </div>
      <div className="relative shrink-0" onMouseEnter={() => setPickTip(true)} onMouseLeave={() => setPickTip(false)}>
        <button
          type="button"
          onClick={onTogglePick}
          disabled={!hasPage}
          aria-label={t.selectElement}
          aria-pressed={picking && hasPage}
          aria-keyshortcuts={PICK_SHORTCUT}
          className={cn(
            "p-1 rounded shrink-0 disabled:opacity-40 disabled:cursor-default",
            picking && hasPage ? ACTIVE_TOGGLE : "text-text-400 enabled:hover:text-text-100 enabled:hover:bg-bg-200",
          )}
        >
          <CursorIcon className="w-[18px] h-[18px]" />
        </button>
        {pickTipShown && <PickElementTip />}
      </div>
    </div>
  );
}
