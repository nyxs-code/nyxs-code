import { useState, type ReactNode } from "react";
import { useTranslations } from "@/lib/i18n";
import {
  PRESETS,
  applyPreset,
  normalizeHex,
  setModeColor,
  useThemeColors,
  type ThemeColors,
  type ThemeMode,
} from "@/lib/themeColors";
import { SettingSelect } from "./SettingSelect";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="text-sm text-text-100">{label}</span>
      {children}
    </div>
  );
}

/** A color as its swatch and hex. The swatch opens the system color picker; the hex can be
 *  typed, and applies as soon as it is a whole color. */
function ColorField({ value, label, onChange }: { value: string; label: string; onChange: (hex: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.slice(1);
  const commit = (text: string) => {
    const hex = normalizeHex(text);
    if (hex && hex !== value) onChange(hex);
    setDraft(null);
  };
  return (
    <div className="inline-flex h-8 items-center gap-2 rounded-[6px] border border-bg-300 bg-bg-200 px-2">
      <label className="relative h-4 w-4 shrink-0 cursor-pointer overflow-hidden rounded-[3px] border border-black/15" style={{ background: value }}>
        <input
          type="color"
          aria-label={label}
          value={value.toLowerCase()}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <span className="text-[13px] text-text-400" aria-hidden>#</span>
      <input
        type="text"
        aria-label={`${label} (hex)`}
        spellCheck={false}
        maxLength={7}
        value={shown}
        onChange={(e) => {
          const text = e.target.value.replace(/^#/, "");
          setDraft(text);
          if (/^[0-9a-f]{6}$/i.test(text)) onChange(`#${text.toUpperCase()}`);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
          else if (e.key === "Escape") setDraft(null);
        }}
        className="w-[4.5rem] bg-transparent font-mono text-[13px] uppercase text-text-100 outline-none"
      />
    </div>
  );
}

/** "Light theme" / "Dark theme": a preset, then its background, text and accent, each editable.
 *  Editing a color turns the preset into "Custom" until the colors match a preset again. */
export function ThemeColorsCard({ mode }: { mode: ThemeMode }) {
  const cs = useTranslations().codeSettings;
  const theme = useThemeColors()[mode];
  const options = [
    ...PRESETS[mode].map((p) => ({ id: p.id, label: p.label })),
    ...(theme.preset === "custom" ? [{ id: "custom", label: cs.themeCustom }] : []),
  ];
  const fields: { key: keyof ThemeColors; label: string }[] = [
    { key: "background", label: cs.themeBackground },
    { key: "foreground", label: cs.themeForeground },
    { key: "accent", label: cs.themeAccent },
  ];
  const title = mode === "light" ? cs.lightThemeTitle : cs.darkThemeTitle;

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-text-100">{title}</h3>
      <div className="divide-y divide-bg-300 rounded-[8px] border border-bg-300 bg-bg-100">
        <Row label={cs.themePreset}>
          <SettingSelect<string>
            ariaLabel={`${title}: ${cs.themePreset}`}
            value={theme.preset}
            options={options}
            onChange={(id) => {
              if (id !== "custom") applyPreset(mode, id);
            }}
          />
        </Row>
        {fields.map((f) => (
          <Row key={f.key} label={f.label}>
            <ColorField value={theme[f.key]} label={`${title}: ${f.label}`} onChange={(hex) => setModeColor(mode, f.key, hex)} />
          </Row>
        ))}
      </div>
    </section>
  );
}

export default ThemeColorsCard;
