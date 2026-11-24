/** The hand-drawn stopwatch of the empty Scheduled page, in the page's text color. */
export function StopwatchArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 88" className={className} fill="none" aria-hidden>
      {/* Slightly uneven strokes, as if drawn with a pen. */}
      <path
        d="M31 6.5c6-.6 12.2-.4 18.2.2M33.5 6.8l.3 7.1M46.6 6.9l-.2 6.8M33.6 13.6c4.3-.3 8.6-.4 12.9-.1"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M40.2 13.8l-.1 6.3" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path
        d="M40.4 20.3c18.6-.3 33.1 13.7 33.2 32.3.1 18.8-14.6 33-33.4 32.8C21.6 85.2 6.6 70.9 6.8 52.3 7 34.4 21.6 20.6 40.4 20.3z"
        fill="currentColor"
        fillOpacity="0.07"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path d="M40.1 31.2l.2 22.4 12.8-7.3" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The wavy line between the empty state and the templates. */
export function WavyDivider({ className }: { className?: string }) {
  return (
    <svg className={className} height="6" width="100%" preserveAspectRatio="none" aria-hidden>
      <defs>
        <pattern id="nyxs-wave" width="12" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 3 Q3 0 6 3 T12 3" fill="none" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="6" fill="url(#nyxs-wave)" />
    </svg>
  );
}
