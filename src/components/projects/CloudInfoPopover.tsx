import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/openExternal";

const CLOUD_DOCS_URL = "https://nyxs.dev/docs/cloud";

/** How long the pointer can be between the link and the card before it closes. */
const CLOSE_DELAY_MS = 150;

/** "en la nube" on the empty Projects page, as in Claude: an underlined link whose hover, focus
 *  or click shows what cloud threads need and can't do, with a link to the docs. Not a plain
 *  tooltip (it has a link inside), so it's a small non-modal dialog the pointer and the keyboard
 *  can both enter. */
export function CloudInfoPopover({ children }: { children: ReactNode }) {
  const t = useTranslations().projects;
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  // Escape gives the focus back to the link: that focus mustn't open the card again.
  const returning = useRef(false);
  const id = useId();

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      returning.current = true;
      wrapRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      returning.current = false;
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  // Focus moving between the link and the card's own link keeps it open.
  const onBlur = (e: FocusEvent) => {
    if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) closeSoon();
  };

  return (
    <span ref={wrapRef} className="relative" onMouseEnter={show} onMouseLeave={closeSoon} onFocus={() => { if (!returning.current) show(); }} onBlur={onBlur}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        onClick={show}
        className="underline underline-offset-2 decoration-text-400 hover:decoration-text-100 focus-visible:outline-none focus-visible:decoration-text-100"
      >
        {children}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={t.cloudInfoTitle}
          className="absolute bottom-full left-0 z-50 mb-2 w-[320px] rounded-[8px] border border-bg-300 bg-bg-100 p-3.5 text-left shadow-lg"
        >
          <ul className="flex list-disc flex-col gap-2 pl-4 text-[12px] leading-relaxed text-text-300">
            <li>{t.cloudInfoRepo}</li>
            <li>{t.cloudInfoSandbox}</li>
            <li>{t.cloudInfoNetwork}</li>
          </ul>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => openExternalUrl(CLOUD_DOCS_URL)}
              className="inline-flex items-center gap-0.5 rounded-[6px] text-[12px] text-accent hover:underline underline-offset-2 focus-visible:outline-none focus-visible:underline"
            >
              {t.cloudInfoLink}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
