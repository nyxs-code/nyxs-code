import type { ReactNode } from "react";

/** One key, the way the shortcuts list draws it. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.75rem] items-center justify-center rounded-[6px] border border-bg-300 bg-bg-200 px-1.5 py-0.5 text-[12px] font-medium text-text-100 shadow-sm">
      {children}
    </kbd>
  );
}

/** A shortcut's keys, or several ways to type it separated by "or". */
export function Chords({ chords, or }: { chords: string[][]; or: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {chords.map((chord, ci) => (
        <span key={ci} className="flex items-center gap-1">
          {ci > 0 && <span className="px-0.5 text-[12px] text-text-400">{or}</span>}
          {chord.map((key, ki) => (
            <Kbd key={ki}>{key}</Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
