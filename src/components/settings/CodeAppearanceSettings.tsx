import { useAppearance, setAppearance, CODE_THEMES, codePaletteFor, type InterfaceFont, type TranscriptTextSize, type ChatWidth, type CodeTheme } from "@/lib/appearance";
import { tokenize } from "@/lib/highlight";
import { useTranslations } from "@/lib/i18n";
import { isHighContrast, setHighContrast, useTheme } from "@/lib/theme";
import { SegmentedControl, SettingGroup, SettingRow, SettingsToggle } from "./settingsControls";
import { fieldInputClass } from "./fieldClasses";
import { SettingSelect } from "./SettingSelect";
import { useSavedField } from "./useSaveOnLeave";

const CODE_PREVIEW_LINES: { ln: string; type: "ctx" | "del" | "add"; code: string }[] = [
  { ln: "1", type: "ctx", code: "function greet(name: string) {" },
  { ln: "2", type: "del", code: '  return "Hello, " + name;' },
  { ln: "2", type: "add", code: "  return `Hello, ${name}!`;" },
  { ln: "3", type: "ctx", code: "}" },
];

function CodeThemePreview({ theme }: { theme: CodeTheme }) {
  const p = codePaletteFor(theme);
  const style = {
    "--code-bg": p.bg, "--code-plain": p.plain, "--code-line": p.line,
    "--code-addBg": p.addBg, "--code-delBg": p.delBg, "--code-comment": p.comment,
    "--code-string": p.string, "--code-keyword": p.keyword, "--code-tag": p.tag,
    "--code-attr": p.attr, "--code-number": p.number, "--code-func": p.func,
  } as React.CSSProperties;
  return (
    <pre
      style={style}
      className="w-full overflow-x-auto rounded-md border border-bg-300 py-1.5 text-[12px] leading-relaxed font-mono whitespace-pre bg-[color:var(--code-bg)] text-[color:var(--code-plain)]"
    >
      {CODE_PREVIEW_LINES.map((l, i) => (
        <div
          key={i}
          className={`flex px-2 ${l.type === "add" ? "bg-[color:var(--code-addBg)]" : l.type === "del" ? "bg-[color:var(--code-delBg)]" : ""}`}
        >
          <span className="select-none w-6 shrink-0 pr-2 text-right text-[color:var(--code-line)]">{l.ln}</span>
          <span className="select-none w-3 shrink-0 text-[color:var(--code-line)]">
            {l.type === "add" ? "+" : l.type === "del" ? "-" : " "}
          </span>
          <span className="min-w-0">
            {tokenize(l.code, "ts").map((t, j) => (
              <span key={j} className={t.cls}>{t.text}</span>
            ))}
          </span>
        </div>
      ))}
    </pre>
  );
}

function CodeThemePicker({
  mode,
  value,
  onChange,
}: {
  mode: "light" | "dark";
  value: CodeTheme;
  onChange: (t: CodeTheme) => void;
}) {
  const cs = useTranslations().codeSettings;
  const options = CODE_THEMES.filter((t) => t.mode === mode);
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <SettingSelect<CodeTheme>
        align="left"
        ariaLabel={mode === "dark" ? cs.darkThemeTitle : cs.lightThemeTitle}
        value={value}
        options={options.map((t) => ({ id: t.id, label: t.label }))}
        onChange={onChange}
      />
      <CodeThemePreview theme={value} />
    </div>
  );
}

export function CodeAppearanceSettings() {
  const cs = useTranslations().codeSettings;
  const tChatUi = useTranslations().chatUi;
  const { preference } = useTheme();
  const appearance = useAppearance();
  const codeFontField = useSavedField(appearance.codeFont, (codeFont) => setAppearance({ codeFont }));
  const highContrast = isHighContrast(preference);

  return (
    <>
      <SettingGroup title={cs.codeAppearanceTitle}>
        <div className="py-3.5">
          <p className="text-sm font-medium text-text-100">{cs.codeThemeTitle}</p>
          <p className="text-[12px] text-text-400 mt-0.5 mb-2.5">{cs.codeThemeDesc}</p>
          <div className="flex gap-3">
            <CodeThemePicker
              mode="dark"
              value={appearance.codeThemeDark}
              onChange={(t) => setAppearance({ codeThemeDark: t })}
            />
            <CodeThemePicker
              mode="light"
              value={appearance.codeThemeLight}
              onChange={(t) => setAppearance({ codeThemeLight: t })}
            />
          </div>
        </div>
        <SettingRow title={cs.codeFontTitle} desc={cs.codeFontDesc}>
          <input
            type="text"
            className={`${fieldInputClass} w-52`}
            placeholder={cs.codeFontPlaceholder}
            {...codeFontField}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={cs.appearanceTitle}>
        <SettingRow title={cs.highContrastTitle} desc={cs.highContrastDesc}>
          <SettingsToggle
            checked={highContrast}
            onChange={setHighContrast}
            label={cs.highContrastTitle}
          />
        </SettingRow>
        <SettingRow title={cs.interfaceFontTitle} desc={cs.interfaceFontDesc}>
          <SegmentedControl<InterfaceFont>
            value={appearance.interfaceFont}
            options={[
              { id: "sans", label: cs.interfaceFontSans },
              { id: "system", label: cs.interfaceFontSystem },
            ]}
            onChange={(v) => setAppearance({ interfaceFont: v })}
          />
        </SettingRow>
        <SettingRow title={cs.transcriptSizeTitle} desc={cs.transcriptSizeDesc}>
          <SegmentedControl<TranscriptTextSize>
            value={appearance.transcriptTextSize}
            options={[
              { id: "small", label: cs.sizeSmall },
              { id: "medium", label: cs.sizeMedium },
              { id: "large", label: cs.sizeLarge },
            ]}
            onChange={(v) => setAppearance({ transcriptTextSize: v })}
          />
        </SettingRow>
        <SettingRow title={tChatUi.widthTitle} desc={tChatUi.widthDesc}>
          <SegmentedControl<ChatWidth>
            value={appearance.chatWidth}
            options={[
              { id: "narrow", label: tChatUi.widthNarrow },
              { id: "comfortable", label: tChatUi.widthComfortable },
              { id: "wide", label: tChatUi.widthWide },
            ]}
            onChange={(v) => setAppearance({ chatWidth: v })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
