import { Keyboard } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslations } from "@/lib/i18n";

interface Shortcut {
  label: string;
  chords: string[][];
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.75rem] items-center justify-center rounded-[6px] border border-bg-300 bg-bg-200 px-1.5 py-0.5 text-[12px] font-medium text-text-100 shadow-sm">
      {children}
    </kbd>
  );
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const translations = useTranslations();
  const t = translations.shortcutsModal;

  if (!open) return null;

  const groups: ShortcutGroup[] = [
    {
      title: t.groupGeneral,
      shortcuts: [
        { label: t.openShortcuts, chords: [["Ctrl", "/"]] },
        { label: t.openSettings, chords: [["Ctrl", ","]] },
        { label: t.newSession, chords: [["Ctrl", "N"]] },
        { label: t.nextSession, chords: [["Ctrl", "Tab"], ["Ctrl", "⇧", "]"]] },
        { label: t.previousSession, chords: [["Ctrl", "⇧", "Tab"], ["Ctrl", "⇧", "["]] },
        { label: translations.search.findPlaceholder, chords: [["Ctrl", "F"]] },
        { label: translations.search.sessionsTitle, chords: [["Ctrl", "K"]] },
        { label: translations.quick.shortcutLabel, chords: [["Ctrl", "⇧", "Space"]] },
        { label: t.stopResponse, chords: [["Esc"]] },
        { label: t.toggleTheme, chords: [["Ctrl", "⇧", "L"]] },
        { label: translations.titleBar.back, chords: [["Alt", "←"]] },
        { label: translations.titleBar.forward, chords: [["Alt", "→"]] },
      ],
    },
    {
      title: t.groupPanels,
      shortcuts: [
        { label: t.toggleDiff, chords: [["Ctrl", "⇧", "D"]] },
        { label: t.togglePreview, chords: [["Ctrl", "⇧", "B"]] },
        { label: translations.views.selectElement, chords: [["Ctrl", "⇧", "S"]] },
        { label: t.toggleFiles, chords: [["Ctrl", "⇧", "F"]] },
        { label: t.toggleTerminal, chords: [["Ctrl", "`"]] },
        { label: t.newTerminal, chords: [["Ctrl", "⇧", "`"]] },
        { label: t.closePanel, chords: [["Ctrl", "\\"]] },
        { label: t.toggleSidebar, chords: [["Ctrl", ";"]] },
        { label: translations.transcriptView.shortcut, chords: [["Ctrl", "O"]] },
        { label: translations.sideChat.shortcut, chords: [["Ctrl", "J"]] },
        { label: translations.environments.pickShortcut, chords: [["Ctrl", "Alt", "1–9"]] },
        { label: translations.environments.newTitle, chords: [["Ctrl", "Alt", "0"]] },
      ],
    },
    {
      title: t.groupComposer,
      shortcuts: [
        { label: t.sendMessage, chords: [["Enter"]] },
        { label: t.newLine, chords: [["⇧", "Enter"]] },
        { label: translations.queue.shortcutQueue, chords: [["Enter"]] },
        { label: translations.queue.shortcutSteer, chords: [["Ctrl", "Enter"]] },
        { label: t.navigateSuggestions, chords: [["↑"], ["↓"]] },
        { label: t.acceptSuggestion, chords: [["Enter"], ["Tab"]] },
        { label: t.closeMenu, chords: [["Esc"]] },
        { label: t.openModeMenu, chords: [["Ctrl", "⇧", "M"]] },
        { label: t.openModelMenu, chords: [["Ctrl", "⇧", "I"]] },
        { label: t.cycleEffort, chords: [["Ctrl", "⇧", "E"]] },
        { label: t.pickMenuItem, chords: [["1–9"]] },
      ],
    },
  ];

  return (
    <Dialog open onClose={onClose} stacked className="max-w-2xl">
      <DialogHeader className="border-b border-bg-300 px-6 py-4">
        <Keyboard className="h-4 w-4 text-accent" />
        <DialogTitle className="text-base font-semibold">{t.title}</DialogTitle>
      </DialogHeader>

      <div className="min-h-0 px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-500">{group.title}</p>
            <div>
              {group.shortcuts.map((s) => (
                <div
                  key={s.label}
                  className="flex items-center justify-between gap-3 border-b border-bg-200/60 py-2 last:border-b-0"
                >
                  <span className="min-w-0 truncate text-sm text-text-200" data-tooltip={s.label}>{s.label}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {s.chords.map((chord, ci) => (
                      <span key={ci} className="flex items-center gap-1">
                        {ci > 0 && <span className="px-0.5 text-[12px] text-text-400">{t.or}</span>}
                        {chord.map((key, ki) => (
                          <Kbd key={ki}>{key}</Kbd>
                        ))}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export default ShortcutsModal;
