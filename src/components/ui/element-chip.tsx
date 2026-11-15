import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { CursorIcon } from "@/components/ui/cursor-icon";
import { elementTagLabel, type PickedElement } from "@/lib/pickedElement";
import { useTranslations } from "@/lib/i18n";

const code = "font-mono text-[12px] leading-relaxed text-text-100 bg-bg-200 rounded-md px-2 py-1.5 whitespace-pre-wrap break-words";

/** What the chip's card shows of a picked element: a screenshot of its area, its tag and text,
 *  and on demand its selector, computed styles, HTML and siblings. */
function ElementCard({ element }: { element: PickedElement }) {
  const t = useTranslations().chatInput;
  const [more, setMore] = useState(false);
  const styles = element.styles ? Object.entries(element.styles) : [];
  const details = [element.path, styles.length > 0, element.html, element.siblings].filter(Boolean).length;
  return (
    <div className="w-80 max-h-[340px] overflow-y-auto custom-scrollbar rounded-lg border border-bg-300 bg-bg-100 shadow-lg p-3 text-[13px] text-left">
      <p className="flex items-center gap-1.5 text-text-300">
        <CursorIcon className="w-3.5 h-3.5 shrink-0" />
        {t.elementIncluded}
      </p>
      {element.screenshot && (
        <img src={element.screenshot} alt="" className="mt-2 w-48 max-h-32 object-cover object-left-top rounded border border-bg-300" />
      )}
      <dl className="mt-2 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-text-400">{t.elementLabel}</dt>
        <dd className="text-text-100">{elementTagLabel(element)}</dd>
        {element.text && (
          <>
            <dt className="text-text-400">{t.elementText}</dt>
            <dd className="text-text-100 break-words">{element.text}</dd>
          </>
        )}
      </dl>
      {details > 0 && (
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          aria-expanded={more}
          className="mt-1.5 inline-flex items-center gap-1.5 text-text-300 hover:text-text-100 transition-colors"
        >
          {more ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          {more ? t.elementHideDetails : t.elementShowMore.replace("{n}", String(details))}
        </button>
      )}
      {more && (
        <dl className="mt-2 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2">
          {element.path && (
            <>
              <dt className="text-text-400">{t.elementSelector}</dt>
              <dd className={code}>{element.path}</dd>
            </>
          )}
          {styles.length > 0 && (
            <>
              <dt className="text-text-400">{t.elementStyles}</dt>
              <dd className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[12px] text-text-100">
                {styles.map(([k, v]) => (
                  <div key={k} className="contents">
                    <span className="break-words">{k}</span>
                    <span className="break-words">{v}</span>
                  </div>
                ))}
              </dd>
            </>
          )}
          {element.html && (
            <>
              <dt className="text-text-400">{t.elementHtml}</dt>
              <dd className={code}>{element.html}</dd>
            </>
          )}
          {element.siblings && (
            <>
              <dt className="text-text-400">{t.elementSiblings}</dt>
              <dd className={code}>{element.siblings}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

/** A picked element in the message box (or a sent message): "<span /> Its text", with a card
 *  of what goes with the message while the pointer is over it. */
export function ElementChip({ element, onRemove }: { element: PickedElement; onRemove?: () => void }) {
  const t = useTranslations().chatInput;
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const show = () => { window.clearTimeout(closeTimer.current); setOpen(true); };
  // A short delay lets the pointer travel from the chip to the card without closing it.
  const hide = () => { window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setOpen(false), 150); };
  return (
    <div className="relative self-start max-w-full animate-fade-in" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <div tabIndex={0} className="group inline-flex items-center gap-1.5 max-w-[200px] px-3 py-2 rounded-md border border-bg-300 bg-bg-100 text-[13px] text-text-200 outline-none focus-visible:ring-1 focus-visible:ring-accent">
        <CursorIcon className="w-3.5 h-3.5 shrink-0 text-text-300" />
        <span className="shrink-0">{elementTagLabel(element)}</span>
        {element.text && <span className="min-w-0 truncate">{element.text}</span>}
      </div>
      {onRemove && open && (
        <button
          onClick={onRemove}
          type="button"
          aria-label={t.removeItem}
          className="absolute -top-2 -right-2 z-10 p-0.5 rounded-full border border-bg-300 bg-bg-100 text-text-400 hover:text-text-100 shadow-sm transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      )}
      {open && (
        <div className="absolute bottom-full left-0 pb-2 z-50">
          <ElementCard element={element} />
        </div>
      )}
    </div>
  );
}
