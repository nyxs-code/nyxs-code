import { Trash2 } from "lucide-react";
import { type PermissionRule } from "@/lib/permissions";
import { useTranslations, type Translations } from "@/lib/i18n";

function ruleLabel(r: PermissionRule, t: Translations["settings"]): string {
  const verb = r.behavior === "allow" ? t.ruleAllow : t.ruleBlock;
  const tmpl = r.ruleContent ? t.ruleWithContent : t.ruleAlways;
  return tmpl
    .replace("{verb}", verb)
    .replace("{tool}", r.toolName)
    .replace("{content}", r.ruleContent ?? "");
}

export function PermissionRulesSection({
  rules,
  onDeleteRule,
  onClearRules,
}: {
  rules: PermissionRule[];
  onDeleteRule?: (index: number) => void;
  onClearRules?: () => void;
}) {
  const t = useTranslations().settings;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-base font-semibold text-text-100">{t.permissionRules}</h3>
        {rules.length > 0 && (
          <button onClick={onClearRules} className="text-[11px] text-text-400 hover:text-red-400">{t.clearAll}</button>
        )}
      </div>
      <p className="text-sm text-text-400 mb-3">{t.permissionRulesDesc}</p>
      {rules.length === 0 ? (
        <p className="text-xs text-text-500 italic">{t.noSavedRules}</p>
      ) : (
        <ul className="space-y-1.5">
          {rules.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-bg-100 border border-bg-300">
              <span className="text-[12px] font-mono text-text-200 truncate" data-tooltip={ruleLabel(r, t)}>{ruleLabel(r, t)}</span>
              <button onClick={() => onDeleteRule?.(i)} className="p-1 rounded text-text-400 hover:text-red-400 shrink-0" aria-label={t.deleteRule}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
