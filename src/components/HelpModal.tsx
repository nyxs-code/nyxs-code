import { Terminal } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BUILTIN_COMMANDS, BUILTIN_PROMPT_COMMANDS, localizeCommandDescription, type SlashCommand } from "@/lib/slashCommand";
import type { CommandDef } from "@/lib/commands";
import { useTranslations } from "@/lib/i18n";

interface CommandRow {
  name: string;
  description: string;
  argumentHint?: string;
}

interface CommandGroup {
  title: string;
  subtitle?: string;
  rows: CommandRow[];
}

/** A skill's description is written for the model and runs for several sentences; the list
 *  only needs what it is about: the first sentence up to its first aside or second clause. */
function skillSummary(text: string): string {
  const sentence = /^(.+?)[.。](\s|$)/.exec(text.trim())?.[1] ?? text.trim();
  const cut = /\s\(|,\s(and|or|then)\s|[:;：；]\s|\s[—–]\s/.exec(sentence.slice(15));
  return cut ? sentence.slice(0, 15 + cut.index) : sentence;
}

export function HelpModal({
  open,
  onClose,
  skillCommands,
  fileCommands,
}: {
  open: boolean;
  onClose: () => void;
  skillCommands: SlashCommand[];
  fileCommands: CommandDef[];
}) {
  const t = useTranslations();
  const th = useTranslations().helpModal;

  if (!open) return null;

  const sc = t.slashCommands as unknown as Record<string, string>;
  const loc = (name: string, fallback: string) => localizeCommandDescription(name, sc, fallback);

  const groups: CommandGroup[] = [
    {
      title: th.availableCommands,
      rows: [
        ...BUILTIN_COMMANDS.map((c) => ({ name: c.name, description: loc(c.name, c.description) })),
        ...BUILTIN_PROMPT_COMMANDS.map((c) => ({
          name: c.name,
          description: loc(c.name, c.description),
          argumentHint: c.argumentHint,
        })),
        ...skillCommands.map((c) => ({ name: c.name, description: sc[c.name] ?? skillSummary(c.description) })),
      ].filter((row, i, rows) => rows.findIndex((r) => r.name === row.name) === i),
    },
  ];
  if (fileCommands.length) {
    groups.push({
      title: th.commands,
      subtitle: ".nyxs/commands",
      rows: fileCommands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
    });
  }

  return (
    <Dialog open onClose={onClose} stacked className="max-w-2xl">
      <DialogHeader className="border-b border-bg-300 px-6 py-4">
        <Terminal className="h-4 w-4 text-accent" />
        <DialogTitle className="text-base font-semibold">{th.availableCommands}</DialogTitle>
      </DialogHeader>

      <div className="min-h-0 px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-500">
              {group.title}
              {group.subtitle && <span className="ml-1.5 normal-case font-normal text-text-400">({group.subtitle})</span>}
            </p>
            <div className="space-y-1.5">
              {group.rows.map((row) => (
                <div key={row.name} className="flex items-baseline gap-2.5">
                  <code className="shrink-0 whitespace-nowrap rounded bg-bg-200 px-1.5 py-0.5 text-[12px] font-medium text-text-100">
                    /{row.name}
                    {row.argumentHint && <span className="ml-1 text-text-400">{row.argumentHint}</span>}
                  </code>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-300">
                    {row.description}
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

export default HelpModal;
