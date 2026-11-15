import { Check, ExternalLink, TriangleAlert } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { DisabledToggle, SettingRow, SettingsToggle } from "./settingsControls";
import { useComputerPermissions, type ComputerPermissionKind } from "./useComputerPermissions";

const button =
  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-medium border border-bg-300 text-text-200 hover:bg-bg-200";

/** The "Computer use" switch. On macOS, while it's on, the two permissions it needs follow it;
 *  where the backend says computer use isn't supported (Linux, macOS before 14) it stays off. */
export function ComputerUseSetting({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const cs = useTranslations().codeSettings;
  const { perms, request } = useComputerPermissions();
  if (perms && !perms.supported) {
    return (
      <div>
        <SettingRow title={cs.computerUseTitle} desc={cs.computerUseDesc}><DisabledToggle /></SettingRow>
        <p className="-mt-2 pb-3.5 text-[12px] text-text-400">{cs.computerUseUnsupported}</p>
      </div>
    );
  }
  const rows: { kind: ComputerPermissionKind; title: string; desc: string; granted: boolean }[] =
    perms?.platform === "macos"
      ? [
        { kind: "accessibility", title: cs.computerPermAccessibility, desc: cs.computerPermAccessibilityDesc, granted: perms.accessibility },
        { kind: "screenRecording", title: cs.computerPermScreen, desc: cs.computerPermScreenDesc, granted: perms.screenRecording },
      ]
      : [];
  return (
    <div>
      <SettingRow title={cs.computerUseTitle} desc={cs.computerUseDesc}>
        <SettingsToggle checked={checked} onChange={onChange} label={cs.computerUseTitle} />
      </SettingRow>
      {checked && rows.length > 0 && (
        <div className="-mt-1.5 pb-3.5 space-y-2">
          {rows.map((r) => (
            <div key={r.kind} className="flex items-center justify-between gap-4 rounded-[8px] border border-bg-300 px-3 py-2">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-text-100">{r.title}</p>
                <p className="text-[12px] text-text-400">{r.desc}</p>
              </div>
              {r.granted ? (
                <span className="shrink-0 inline-flex items-center gap-1 text-[12px] text-green-500">
                  <Check className="w-3.5 h-3.5" aria-hidden /> {cs.computerPermGranted}
                </span>
              ) : (
                <div className="shrink-0 flex items-center gap-3">
                  <span className="inline-flex items-center gap-1 text-[12px] text-amber-500">
                    <TriangleAlert className="w-3.5 h-3.5" aria-hidden /> {cs.computerPermMissing}
                  </span>
                  <button type="button" className={button} onClick={() => void request(r.kind)}>
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden /> {cs.computerPermOpen}
                  </button>
                </div>
              )}
            </div>
          ))}
          {!rows[1].granted && <p className="text-[12px] text-text-400">{cs.computerPermRestartNote}</p>}
        </div>
      )}
    </div>
  );
}
