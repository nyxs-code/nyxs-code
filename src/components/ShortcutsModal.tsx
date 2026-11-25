import { useState } from "react";
import { Keyboard, Search } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FixedShortcutRow, ShortcutRow } from "@/components/shortcuts/ShortcutRow";
import { useTranslations } from "@/lib/i18n";
import { useSettings } from "@/lib/useSettings";
import {
  DEFAULT_BINDINGS,
  SHORTCUT_IDS,
  chordKeys,
  resetAllOverrides,
  useBindings,
  type FixedShortcut,
  type ShortcutId,
  type ShortcutOverrides,
} from "@/lib/keyBindings";
import type { NyxsSettings } from "@/lib/settingsRuntime";

/** A row of the list: a shortcut the user can change (`id`), or fixed keys. */
type Row = { label: string; id: ShortcutId } | { label: string; chords: string[][] };

interface ShortcutGroup {
  title: string;
  rows: Row[];
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <ShortcutsDialog onClose={onClose} />;
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const translations = useTranslations();
  const t = translations.shortcutsModal;
  const { settings, update } = useSettings();
  const enterNewline = (settings as { enterNewline?: boolean }).enterNewline ?? false;
  const bindings = useBindings();
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [said, setSaid] = useState("");

  const groups: ShortcutGroup[] = [
    {
      title: t.groupGeneral,
      rows: [
        { label: t.openShortcuts, id: "openShortcuts" },
        { label: t.openSettings, id: "openSettings" },
        { label: t.newSession, id: "newSession" },
        { label: t.nextSession, chords: [["Ctrl", "Tab"], ["Ctrl", "⇧", "]"]] },
        { label: t.previousSession, chords: [["Ctrl", "⇧", "Tab"], ["Ctrl", "⇧", "["]] },
        { label: translations.search.findPlaceholder, id: "find" },
        { label: translations.search.sessionsTitle, id: "searchSessions" },
        { label: translations.quick.shortcutLabel, chords: [["Ctrl", "⇧", "Space"]] },
        { label: t.stopResponse, chords: [["Esc"]] },
        { label: t.toggleTheme, id: "toggleTheme" },
        { label: translations.titleBar.back, chords: [["Alt", "←"]] },
        { label: translations.titleBar.forward, chords: [["Alt", "→"]] },
      ],
    },
    {
      title: t.groupPanels,
      rows: [
        { label: t.toggleDiff, id: "toggleDiff" },
        { label: t.togglePreview, id: "togglePreview" },
        { label: translations.views.selectElement, id: "selectElement" },
        { label: t.toggleFiles, id: "toggleFiles" },
        { label: t.toggleTerminal, id: "toggleTerminal" },
        { label: t.newTerminal, id: "newTerminal" },
        { label: t.closePanel, id: "closePanel" },
        { label: t.toggleSidebar, id: "toggleSidebar" },
        { label: translations.transcriptView.shortcut, id: "transcriptView" },
        { label: translations.sideChat.shortcut, id: "sideChat" },
        { label: translations.environments.pickShortcut, chords: [["Ctrl", "Alt", "1–9"]] },
        { label: translations.environments.newTitle, chords: [["Ctrl", "Alt", "0"]] },
      ],
    },
    {
      title: t.groupComposer,
      rows: [
        // Settings › General › "Enter starts a new line" moves sending to Ctrl+Enter.
        { label: t.sendMessage, chords: enterNewline ? [["Ctrl", "Enter"]] : [["Enter"]] },
        { label: t.newLine, chords: enterNewline ? [["Enter"], ["⇧", "Enter"]] : [["⇧", "Enter"]] },
        { label: translations.queue.shortcutQueue, chords: enterNewline ? [["Ctrl", "Enter"]] : [["Enter"]] },
        { label: translations.queue.shortcutSteer, chords: enterNewline ? [["Ctrl", "⇧", "Enter"]] : [["Ctrl", "Enter"]] },
        { label: translations.commandBackground.shortcut, id: "moveToBackground" },
        { label: t.navigateSuggestions, chords: [["↑"], ["↓"]] },
        { label: t.acceptSuggestion, chords: [["Enter"], ["Tab"]] },
        { label: t.closeMenu, chords: [["Esc"]] },
        { label: t.openModeMenu, id: "modeMenu" },
        { label: t.openModelMenu, id: "modelMenu" },
        { label: t.cycleEffort, id: "effort" },
        { label: t.pickMenuItem, chords: [["1–9"]] },
      ],
    },
  ];

  const names = new Map<ShortcutId, string>();
  for (const g of groups) for (const r of g.rows) if ("id" in r) names.set(r.id, r.label);
  const nameOf = (id: ShortcutId) => names.get(id) ?? id;
  const fixedNames: Record<FixedShortcut, string> = {
    nextSession: t.nextSession,
    previousSession: t.previousSession,
    newBrowserTab: t.newBrowserTab,
    diffFileList: t.diffFileList,
  };

  const changedCount = SHORTCUT_IDS.filter((id) => bindings[id] !== DEFAULT_BINDINGS[id]).length;
  const filterOn = changedOnly && changedCount > 0;
  const q = query.trim().toLowerCase();
  const keysText = (r: Row) => ("id" in r ? (bindings[r.id] ? chordKeys(bindings[r.id]!) : []) : r.chords.flat()).join(" ").toLowerCase();
  const visible = groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) => {
        if (filterOn && !("id" in r && bindings[r.id] !== DEFAULT_BINDINGS[r.id])) return false;
        return !q || r.label.toLowerCase().includes(q) || keysText(r).includes(q);
      }),
    }))
    .filter((g) => g.rows.length > 0);

  const save = (change: ShortcutOverrides, text: string) => {
    void update({ shortcuts: change } as Partial<NyxsSettings>, "user");
    setSaid(text);
  };

  return (
    <Dialog open onClose={onClose} stacked className="max-w-2xl">
      <DialogHeader className="border-b border-bg-300 px-6 py-4">
        <Keyboard className="h-4 w-4 text-accent" />
        <DialogTitle className="text-base font-semibold">{t.title}</DialogTitle>
      </DialogHeader>

      <div className="min-h-0 px-6 py-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
        <div className="mb-4 flex items-center gap-2">
          <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 text-text-500 focus-within:border-accent">
            <Search className="h-3.5 w-3.5 shrink-0" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.search}
              aria-label={t.search}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-text-100 outline-none placeholder:text-text-500"
            />
          </label>
          <Button
            variant="ghost"
            aria-pressed={filterOn}
            disabled={changedCount === 0}
            className={filterOn ? "bg-bg-200 text-text-100" : undefined}
            onClick={() => setChangedOnly(!filterOn)}
          >
            {t.changed}
          </Button>
          <Button disabled={changedCount === 0} onClick={() => setConfirmReset(true)}>
            {t.resetAll}
          </Button>
        </div>
        <p className="mb-4 text-[13px] text-text-300">{t.editableNote}</p>

        <div className="space-y-5">
          {visible.map((group) => (
            <div key={group.title}>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-500">{group.title}</p>
              <div>
                {group.rows.map((r) =>
                  "id" in r ? (
                    <ShortcutRow
                      key={r.id}
                      id={r.id}
                      label={r.label}
                      bindings={bindings}
                      nameOf={nameOf}
                      fixedName={(by) => fixedNames[by]}
                      onSave={save}
                    />
                  ) : (
                    <FixedShortcutRow key={r.label} label={r.label} chords={r.chords} or={t.or} />
                  ),
                )}
              </div>
            </div>
          ))}
          {visible.length === 0 && <p className="text-[13px] text-text-400">{t.noMatches}</p>}
        </div>
        <p role="status" className="sr-only">{said}</p>
      </div>

      <Dialog open={confirmReset} onClose={() => setConfirmReset(false)} stacked role="alertdialog">
        <DialogHeader>
          <DialogTitle>{t.resetAllTitle}</DialogTitle>
        </DialogHeader>
        <p className="px-4 text-[13px] text-text-300">{t.resetAllDesc}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmReset(false)}>{t.cancel}</Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmReset(false);
              setChangedOnly(false);
              save(resetAllOverrides(), t.resetDone);
            }}
          >
            {t.resetAll}
          </Button>
        </DialogFooter>
      </Dialog>
    </Dialog>
  );
}

export default ShortcutsModal;
