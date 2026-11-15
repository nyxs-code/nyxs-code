import { createContext, useContext, useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import { useShownOverNativeViews } from "@/lib/nativeViews";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Hidden controls (display: none, inside a closed section) can't take the focus. */
const isVisible = (el: HTMLElement) => (typeof el.checkVisibility === "function" ? el.checkVisibility() : true);

const DialogContext = createContext<{ titleId: string; onClose: () => void; dismissible: boolean }>({
  titleId: "",
  onClose: () => {},
  dismissible: true,
});

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Classes for the panel: its width and height, padding, layout. */
  className?: string;
  /** "alertdialog" for a question the user has to answer (a confirmation). */
  role?: "dialog" | "alertdialog";
  /** When the dialog has no `DialogTitle`, what screen readers call it. */
  label?: string;
  /** The id of the text that explains the dialog, for screen readers. */
  describedBy?: string;
  /** What gets the focus when the dialog opens; the first control otherwise. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** False when Escape and a click outside must not close it (a required choice). */
  dismissible?: boolean;
  /** Above other dialogs (a confirmation opened from one). */
  stacked?: boolean;
}

/** A dialog over the app. The title bar is only dimmed, not blocked, so the window can still be
 *  moved. Escape or a click on the backdrop closes it, the focus stays inside while it is open
 *  and goes back where it was when it closes. Over a website open in the browser panel it
 *  waits until the page has stepped aside (on Windows the page cuts a hole for it instead, so a
 *  video keeps playing). */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <DialogPanel {...props} />;
}

function DialogPanel({
  onClose,
  children,
  className,
  role = "dialog",
  label,
  describedBy,
  initialFocus,
  dismissible = true,
  stacked = false,
}: DialogProps) {
  const visible = useShownOverNativeViews(true);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    // A dialog opened inside this one already took the focus (its effect runs first).
    if (panel?.contains(document.activeElement)) return;
    // The first control, but not the header's close button: landing there reads as "close".
    const first = [...(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find((el) => !el.hasAttribute("data-dialog-close"));
    const target = initialFocus?.current ?? first ?? panel;
    target?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // The innermost dialog handles it; the ones under it, and the app, don't.
      e.stopPropagation();
      if (!dismissible || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // A dialog opened inside this one keeps the focus to itself.
    e.stopPropagation();
    const panel = panelRef.current;
    if (!panel) return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
    {/* The title bar is dimmed too, but clicks go through so the window can still be moved. */}
    <div
      aria-hidden
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 h-9 z-[61] bg-black/30 transition-opacity duration-100",
        visible ? "opacity-100" : "opacity-0",
      )}
    />
    <div
      data-webview-backdrop
      className={cn(
        "fixed inset-x-0 bottom-0 top-9 flex items-center justify-center bg-black/30 p-6 transition-opacity duration-100",
        stacked ? "z-[60]" : "z-50",
        visible ? "opacity-100" : "opacity-0",
      )}
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        data-webview-hole
        role={role}
        aria-modal="true"
        aria-labelledby={label ? undefined : titleId}
        aria-label={label}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          "relative flex max-h-full w-full max-w-md flex-col rounded-[8px] border border-bg-300 bg-bg-100 shadow-2xl outline-none",
          className,
        )}
      >
        <DialogContext.Provider value={{ titleId, onClose, dismissible }}>{children}</DialogContext.Provider>
      </div>
    </div>
    </>
  );
}

/** The dialog's name; screen readers announce it when the dialog opens. */
export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  const { titleId } = useContext(DialogContext);
  return (
    <h2 id={titleId} className={cn("text-[14px] font-medium text-text-100", className)}>
      {children}
    </h2>
  );
}

/** The top row: the title (and anything beside it) and a close button. */
export function DialogHeader({ children, className, close = true }: { children: ReactNode; className?: string; close?: boolean }) {
  const { onClose, dismissible } = useContext(DialogContext);
  const t = useTranslations().modals;
  return (
    <header className={cn("flex shrink-0 items-center justify-between gap-3 px-4 pt-3.5 pb-2", className)}>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      {close && dismissible && (
        <Button variant="ghost" icon onClick={onClose} aria-label={t.close} data-dialog-close className="-mr-1.5">
          <X className="h-4 w-4" />
        </Button>
      )}
    </header>
  );
}

/** The buttons at the bottom, aligned to the right. */
export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <footer className={cn("flex shrink-0 items-center justify-end gap-2 px-4 pb-4 pt-3", className)}>{children}</footer>;
}
