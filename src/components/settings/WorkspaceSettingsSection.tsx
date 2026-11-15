import { useState } from "react";
import { type Settings } from "@/lib/settings";
import { getAllOutputStyles, DEFAULT_OUTPUT_STYLE } from "@/lib/outputStyles";
import { type ToolAccessMode } from "@/lib/configSchema";
import { useTranslations } from "@/lib/i18n";
import { useSettings } from "@/lib/useSettings";
import { type SettingsSource } from "@/lib/settingsRuntime";
import { SettingSelect } from "./SettingSelect";
import { SegmentedControl, SelectRow, SettingRow } from "./settingsControls";

export function WorkspaceSettingsSection(_props: {
  providerSettings: Settings;
  workspace?: string | null;
}) {
  const t = useTranslations().settings;
  const { settings, update } = useSettings();
  const [writeLayer] = useState<SettingsSource>("user");
  const set = async (patch: Parameters<typeof update>[0]) => {
    await update(patch, writeLayer);
  };

  return (
    <div className="space-y-8">
      <div className="border-t border-bg-300">
        <SelectRow title={t.outputStyle} desc={t.outputStyleDesc}>
          <SettingSelect
            ariaLabel={t.outputStyle}
            value={settings.outputStyle ?? DEFAULT_OUTPUT_STYLE}
            options={getAllOutputStyles().map((s) => ({
              id: s.id,
              label: t.outputStyles[s.id as keyof typeof t.outputStyles]?.name ?? s.name,
            }))}
            onChange={(id) => set({ outputStyle: id })}
          />
        </SelectRow>
        <ToolAccessSettings />
      </div>

      <div className="border-t border-bg-300">
        <SettingRow
          title={t.capabilitiesPage.cleanupTitle}
          desc={t.capabilitiesPage.cleanupDesc}
        >
          <SegmentedControl
            value={String(((settings as Record<string, unknown>).cleanupPeriodDays as number | undefined) ?? 30)}
            options={[
              { id: "7", label: t.capabilitiesPage.cleanupWeekly },
              { id: "15", label: t.capabilitiesPage.cleanupBiweekly },
              { id: "30", label: t.capabilitiesPage.cleanupMonthly },
            ]}
            onChange={(v) => set({ cleanupPeriodDays: parseInt(v, 10) } as Parameters<typeof update>[0])}
          />
        </SettingRow>
      </div>
    </div>
  );
}

function ToolAccessSettings() {
  const t = useTranslations().settings;
  const { settings, update } = useSettings();
  return (
    <div className="border-t border-bg-300">
      <SelectRow title={t.toolAccessTitle} desc={t.toolAccessDesc}>
        <SettingSelect<ToolAccessMode>
          ariaLabel={t.toolAccessTitle}
          value={settings.toolAccessMode === "preloaded" ? "preloaded" : "onDemand"}
          options={[
            { id: "onDemand", label: t.toolAccessOnDemand, description: t.toolAccessOnDemandDesc },
            { id: "preloaded", label: t.toolAccessPreloaded, description: t.toolAccessPreloadedDesc },
          ]}
          onChange={(toolAccessMode) => void update({ toolAccessMode }, "user")}
        />
      </SelectRow>
    </div>
  );
}
