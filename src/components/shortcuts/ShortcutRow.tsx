import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import {
  DEFAULT_BINDINGS,
  chordKeys,
  chordOf,
  clashesWith,
  isModifierOnly,
  overridesFor,
  problemWith,
  setRecordingShortcut,
  worksInPages,
  type Bindings,
  type Chord,
  type ChordProblem,
  type ShortcutId,
  type ShortcutOverrides,
} from "@/lib/keyBindings";
import { cn } from "@/lib/utils";
import { Chords } from "./Kbd";

/** What the row shows while its shortcut is being changed. */
interface Editing {
  /** The keys pressed, once there are some. */
  chord?: Chord;
  problem?: ChordProblem;
  /** The shortcuts that already use `chord`: Replace takes it from them. */
  clashes?: ShortcutId[];
  /** Reset to the default, which another shortcut took meanwhile. */
  byReset?: boolean;
}

export interface ShortcutRowProps {
  id: ShortcutId;
  label: string;
  bindings: Bindings;
  /** Every changeable shortcut's name, for "Used by …". */
  nameOf: (id: ShortcutId) => string;
  /** The name of a shortcut that can't be changed, by what `problemWith` says. */
  fixedName: (by: Extract<ChordProblem, { kind: "fixed" }>["by"]) => string;
  onSave: (change: ShortcutOverrides, said: string) => void;
}

/** A shortcut the user can change: its keys, a pencil that records new ones and, once changed, a
 *  button back to the default. Like Claude's: a clash asks to Replace, reserved keys are refused. */
export function ShortcutRow({ id, label, bindings, nameOf, fixedName, onSave }: ShortcutRowProps) {
  const t = useTranslations().shortcutsModal;
  const [editing, setEditing] = useState<Editing | null>(null);
  const pencilRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const noteId = useId();
  const chord = bindings[id];
  const changed = chord !== DEFAULT_BINDINGS[id];

  // The app's own shortcuts wait while the keys are recorded.
  useEffect(() => {
    if (!editing) return;
    setRecordingShortcut(true);
    return () => setRecordingShortcut(false);
  }, [editing]);

  const stop = () => {
    setEditing(null);
    pencilRef.current?.focus({ preventScroll: true });
  };

  const save = (next: Chord | null, clear: ShortcutId[] = []) => {
    setEditing(null);
    onSave(overridesFor(id, next, clear), next ? t.saved : t.removed);
    pencilRef.current?.focus({ preventScroll: true });
  };

  const tryChord = (next: Chord, byReset = false) => {
    const problem = problemWith(next);
    if (problem) return setEditing({ chord: next, problem });
    if (next === chord) return stop();
    const clashes = clashesWith(id, next, bindings);
    if (clashes.length) return setEditing({ chord: next, clashes, byReset });
    save(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!editing) return;
    // Tab moves on (to Replace, say); everything else is the new shortcut.
    if (e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stop();
    if (isModifierOnly(e.nativeEvent)) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (plain && (e.key === "Backspace" || e.key === "Delete")) return save(null);
    const next = chordOf(e.nativeEvent);
    if (!next) return setEditing({ problem: { kind: "needsModifier" } });
    tryChord(next);
  };

  const reset = () => {
    const def = DEFAULT_BINDINGS[id];
    const clashes = clashesWith(id, def, bindings);
    if (clashes.length) {
      pencilRef.current?.focus({ preventScroll: true });
      setEditing({ chord: def, clashes, byReset: true });
      return;
    }
    onSave(overridesFor(id, def), t.resetDone);
  };

  const shown = editing?.chord ?? null;
  const clashNames = editing?.clashes?.map(nameOf).join(", ");
  let note: ReactNode = null;
  if (editing?.problem) {
    const p = editing.problem;
    note = (
      <p className="text-danger">
        {p.kind === "reserved" ? t.reserved : p.kind === "fixed" ? t.usedBy.replace("{name}", fixedName(p.by)) : t.needsModifier}
      </p>
    );
  } else if (editing?.clashes && clashNames) {
    note = (
      <p>
        <span className="text-warning">{t.alsoUsedBy.replace("{name}", clashNames)}</span> {t.willHaveNone.replace("{name}", clashNames)}
      </p>
    );
  } else if (editing && !editing.byReset) {
    note = <p>{t.recordHint}</p>;
  } else if (!editing && chord && changed && worksInPages(DEFAULT_BINDINGS[id]) && !worksInPages(chord)) {
    note = <p>{t.notInBrowser}</p>;
  }

  return (
    <div
      ref={rowRef}
      className="border-b border-bg-200/60 last:border-b-0"
      onBlur={(e) => {
        // Leaving the row (not moving to its Replace button) drops what was being recorded.
        if (editing && !rowRef.current?.contains(e.relatedTarget as Node | null)) setEditing(null);
      }}
    >
      <div className="flex min-h-[2.25rem] items-center justify-between gap-3 py-1">
        <span className="min-w-0 truncate text-sm text-text-200">{label}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {changed && !editing && (
            <>
              <span className="text-[12px] text-text-400">{t.changed}</span>
              <Button variant="ghost" icon onClick={reset} aria-label={t.resetOne.replace("{name}", label)} data-tooltip={t.resetOne.replace("{name}", label)}>
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-[6px]",
              editing && "bg-bg-200 py-0.5 pl-2.5 pr-0.5 ring-1 ring-accent",
            )}
          >
            {editing ? (
              shown ? (
                <Chords chords={[chordKeys(shown)]} or={t.or} />
              ) : (
                <span className="text-[13px] text-text-400">{t.pressShortcut}</span>
              )
            ) : chord ? (
              <Chords chords={[chordKeys(chord)]} or={t.or} />
            ) : (
              <span className="text-[13px] text-text-400">{t.noShortcut}</span>
            )}
            <Button
              ref={pencilRef}
              variant="ghost"
              icon
              aria-pressed={!!editing}
              aria-label={t.changeFor.replace("{name}", label)}
              aria-describedby={note ? noteId : undefined}
              className={cn(editing && "bg-bg-300 text-text-100")}
              onKeyDown={onKeyDown}
              onClick={(e) => {
                // WebKit doesn't focus a clicked button; the keys go where the focus is.
                e.currentTarget.focus({ preventScroll: true });
                setEditing(editing ? null : {});
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </span>
        </span>
      </div>
      {note && (
        <div id={noteId} className="-mt-0.5 flex items-center justify-end gap-3 pb-2 text-right text-[12px] text-text-400">
          {note}
          {editing?.clashes && editing.chord && (
            <Button className="h-6 px-2.5 text-[12px]" onClick={() => save(editing.chord!, editing.clashes)}>
              {t.replace}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A shortcut that can't be changed: its keys, with the pencil's room kept so they line up. */
export function FixedShortcutRow({ label, chords, or }: { label: string; chords: string[][]; or: string }) {
  return (
    <div className="flex min-h-[2.25rem] items-center justify-between gap-3 border-b border-bg-200/60 py-1 last:border-b-0">
      <span className="min-w-0 truncate text-sm text-text-200">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Chords chords={chords} or={or} />
        <span className="h-7 w-7" aria-hidden />
      </span>
    </div>
  );
}
