/** The classic arrow cursor with its tail, leaning a little (lucide has no such icon). Used for
 *  the browser's element picker and for picked elements in the chat. */
export function CursorIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3v15.5l3.9-3.5 2.5 5.6 2.5-1.1-2.5-5.5h5.1z" transform="rotate(-15 12 12)" />
    </svg>
  );
}
