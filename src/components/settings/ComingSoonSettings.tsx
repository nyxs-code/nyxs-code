import { useState, useEffect, useRef } from "react";
import { useAppearance, setAppearance } from "@/lib/appearance";
import { useTranslations } from "@/lib/i18n";
import { consumePendingHighlight, onSettingHighlight } from "@/lib/settingsHighlight";
import { useSettings } from "@/lib/useSettings";
import { DisabledToggle, SettingGroup, SettingRow, SettingsToggle } from "./settingsControls";
import { fieldInputClass } from "./fieldClasses";
import { SettingSelect } from "./SettingSelect";
import { ComputerUseSetting } from "./ComputerUseSetting";
import { useSavedField } from "./useSaveOnLeave";
import type { FeatureSettings } from "@/lib/featureSettings";
import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINES, isValidSearchTemplate, type SearchEngineId } from "@/lib/searchEngines";
import { setTranscriptView, useTranscriptView, type TranscriptView } from "@/lib/transcriptView";

export function ComingSoonSettings() {
  const cs = useTranslations().codeSettings;
  const appearance = useAppearance();
  const { settings, update } = useSettings();
  const pr = (settings as { pullRequests?: { autoCreate?: boolean; autoFix?: boolean; autoArchive?: boolean } }).pullRequests ?? {};
  const autoPr = pr.autoCreate ?? false;
  const autoFixPr = pr.autoFix ?? false;
  const autoArchivePr = pr.autoArchive ?? false;
  // Only the change goes in, as in setFeature below: the merged view holds the project's values too.
  const setPr = (patch: { autoCreate?: boolean; autoFix?: boolean; autoArchive?: boolean }) =>
    update({ pullRequests: patch } as Parameters<typeof update>[0], "user");
  const allowBypass = (settings as { allowPermissionBypass?: boolean }).allowPermissionBypass ?? false;
  const allowPreview = (settings as { allowPreview?: boolean }).allowPreview ?? true;
  const allowComputerUse = (settings as { allowComputerUse?: boolean }).allowComputerUse ?? false;
  const wt = (settings as { worktree?: { location?: string; branchPrefix?: string; isolateSubagents?: boolean } }).worktree ?? {};
  const setWt = (patch: { location?: string; branchPrefix?: string; isolateSubagents?: boolean }) =>
    update({ worktree: patch } as Parameters<typeof update>[0], "user");
  const classifyStates = (settings as { classifySessionStates?: boolean }).classifySessionStates ?? false;
  // The fields show the defaults as text; passing through them must not save those.
  const locationField = useSavedField(wt.location || "~/.nyxs/worktree", (location) => setWt({ location }));
  const prefixField = useSavedField(wt.branchPrefix || "Nyxs", (branchPrefix) => setWt({ branchPrefix }));
  // What came from Claude Code Desktop (see featureSettings.ts): all on unless turned off.
  const fs = settings as FeatureSettings;
  type Section = "browser" | "chat" | "files" | "sessions" | "permissions";
  // Only the change goes in: settings.json is deep-merged, and `permissions` also holds the
  // allow/deny rules, which the merged view mixes from the project's files.
  const setFeature = (section: Section, patch: Record<string, unknown>) =>
    update({ [section]: patch } as Parameters<typeof update>[0], "user");
  const searchUrlField = useSavedField(fs.browser?.customSearchUrl ?? "", (customSearchUrl) => setFeature("browser", { customSearchUrl }));
  const suggestUrlField = useSavedField(fs.browser?.customSuggestUrl ?? "", (customSuggestUrl) => setFeature("browser", { customSuggestUrl }));
  const view = useTranscriptView();
  const mi = useTranslations().chatInput;
  const tv = useTranslations().transcriptView;
  const defaultMode = fs.permissions?.defaultMode ?? "unset";
  const bypassRef = useRef<HTMLDivElement>(null);
  const bypassTimer = useRef<number | undefined>(undefined);
  const [bypassFlash, setBypassFlash] = useState(false);
  useEffect(() => {
    const flash = () => {
      setBypassFlash(true);
      bypassRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      window.clearTimeout(bypassTimer.current);
      bypassTimer.current = window.setTimeout(() => setBypassFlash(false), 6000);
    };
    if (consumePendingHighlight("permissionBypass")) flash();
    const off = onSettingHighlight("permissionBypass", flash);
    return () => { off(); window.clearTimeout(bypassTimer.current); };
  }, []);
  return (
    <>
      <SettingGroup title={cs.generalTitle}>
        <SettingRow title={cs.classifyStatesTitle} desc={cs.classifyStatesDesc}>
          <SettingsToggle
            checked={classifyStates}
            onChange={(v) => update({ classifySessionStates: v } as Parameters<typeof update>[0], "user")}
            label={cs.classifyStatesTitle}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={cs.localSessionsTitle}>
        <div
          ref={bypassRef}
          className={`rounded-lg transition-all duration-500 ${bypassFlash ? "animate-pulse ring-2 ring-accent bg-accent/10 px-2 -mx-2" : ""}`}
        >
          <SettingRow title={cs.permissionBypassTitle} desc={cs.permissionBypassDesc}>
            <SettingsToggle
              checked={allowBypass}
              onChange={(v) => {
                if (v) { window.clearTimeout(bypassTimer.current); setBypassFlash(false); }
                update({ allowPermissionBypass: v } as Parameters<typeof update>[0], "user");
              }}
              label={cs.permissionBypassTitle}
            />
          </SettingRow>
        </div>
        <SettingRow title={cs.remoteControlTitle} desc={cs.remoteControlDesc} soon><DisabledToggle /></SettingRow>
        <SettingRow title={cs.attentionTitle} desc={cs.attentionDesc}>
          <SettingsToggle
            checked={appearance.requestAttention}
            onChange={(v) => setAppearance({ requestAttention: v })}
            label={cs.attentionTitle}
          />
        </SettingRow>
        <SettingRow title={cs.worktreeLocationTitle} desc={cs.worktreeLocationDesc}>
          <input
            type="text"
            className={`${fieldInputClass} w-52`}
            placeholder="~/.nyxs/worktree"
            {...locationField}
          />
        </SettingRow>
        <SettingRow title={cs.branchPrefixTitle} desc={cs.branchPrefixDesc}>
          <input
            type="text"
            className={`${fieldInputClass} w-52`}
            placeholder="Nyxs"
            {...prefixField}
          />
        </SettingRow>
        <SettingRow title={cs.worktreeIsolateTitle} desc={cs.worktreeIsolateDesc}>
          <SettingsToggle
            checked={wt.isolateSubagents ?? false}
            onChange={(v) => setWt({ isolateSubagents: v })}
            label={cs.worktreeIsolateTitle}
          />
        </SettingRow>
        <SettingRow title={cs.previewTitle} desc={cs.previewDesc}>
          <SettingsToggle
            checked={allowPreview}
            onChange={(v) => update({ allowPreview: v } as Parameters<typeof update>[0], "user")}
            label={cs.previewTitle}
          />
        </SettingRow>
        <ComputerUseSetting
          checked={allowComputerUse}
          onChange={(v) => update({ allowComputerUse: v } as Parameters<typeof update>[0], "user")}
        />
        <SettingRow title={cs.archiveWarnTitle} desc={cs.archiveWarnDesc}>
          <SettingsToggle
            checked={fs.sessions?.warnUncommittedArchive ?? true}
            onChange={(v) => setFeature("sessions", { warnUncommittedArchive: v })}
            label={cs.archiveWarnTitle}
          />
        </SettingRow>
        <SettingRow title={cs.modePerFolderTitle} desc={cs.modePerFolderDesc}>
          <SettingsToggle
            checked={fs.permissions?.rememberModePerFolder ?? true}
            onChange={(v) => setFeature("permissions", { rememberModePerFolder: v })}
            label={cs.modePerFolderTitle}
          />
        </SettingRow>
        <SettingRow title={cs.defaultModeTitle} desc={cs.defaultModeDesc}>
          <SettingSelect
            value={defaultMode}
            ariaLabel={cs.defaultModeTitle}
            onChange={(v) => setFeature("permissions", { defaultMode: v === "unset" ? undefined : v })}
            options={[
              { id: "unset", label: cs.defaultModeUnset },
              { id: "ask", label: mi.modeAsk },
              { id: "auto", label: mi.modeAuto },
              { id: "acceptEdits", label: mi.modeAcceptEdits },
              { id: "plan", label: mi.modePlan },
            ]}
          />
        </SettingRow>
        <SettingRow title={cs.readOnlyAutoTitle} desc={cs.readOnlyAutoDesc}>
          <SettingsToggle
            checked={fs.permissions?.autoApproveReadOnly ?? true}
            onChange={(v) => setFeature("permissions", { autoApproveReadOnly: v })}
            label={cs.readOnlyAutoTitle}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={cs.chatTitle}>
        <SettingRow title={cs.chatViewTitle} desc={cs.chatViewDesc}>
          <SettingSelect<TranscriptView>
            value={view}
            ariaLabel={cs.chatViewTitle}
            onChange={(v) => setTranscriptView(v)}
            options={[
              { id: "normal", label: tv.normal },
              { id: "thinking", label: tv.thinking },
              { id: "verbose", label: tv.verbose },
            ]}
          />
        </SettingRow>
        <SettingRow title={cs.clickablePathsTitle} desc={cs.clickablePathsDesc}>
          <SettingsToggle
            checked={fs.chat?.clickablePaths ?? true}
            onChange={(v) => setFeature("chat", { clickablePaths: v })}
            label={cs.clickablePathsTitle}
          />
        </SettingRow>
        <SettingRow title={cs.planWarningTitle} desc={cs.planWarningDesc}>
          <SettingsToggle
            checked={fs.chat?.planLimitWarning ?? true}
            onChange={(v) => setFeature("chat", { planLimitWarning: v })}
            label={cs.planWarningTitle}
          />
        </SettingRow>
        <SettingRow title={cs.splitViewTitle} desc={cs.splitViewDesc}>
          <SettingsToggle
            checked={fs.chat?.splitView ?? true}
            onChange={(v) => setFeature("chat", { splitView: v })}
            label={cs.splitViewTitle}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={cs.browserTitle}>
        <SettingRow title={cs.browserThemeTitle} desc={cs.browserThemeDesc}>
          <SettingsToggle
            checked={fs.browser?.followTheme ?? true}
            onChange={(v) => setFeature("browser", { followTheme: v })}
            label={cs.browserThemeTitle}
          />
        </SettingRow>
        <SettingRow title={cs.browserReloadTitle} desc={cs.browserReloadDesc}>
          <SettingsToggle
            checked={fs.browser?.reloadOnTheme ?? true}
            onChange={(v) => setFeature("browser", { reloadOnTheme: v })}
            label={cs.browserReloadTitle}
          />
        </SettingRow>
        <SettingRow title={cs.searchEngineTitle} desc={cs.searchEngineDesc}>
          <SettingSelect<SearchEngineId>
            value={(SEARCH_ENGINES.some((e) => e.id === fs.browser?.searchEngine) || fs.browser?.searchEngine === "custom"
              ? fs.browser?.searchEngine
              : DEFAULT_SEARCH_ENGINE) as SearchEngineId}
            ariaLabel={cs.searchEngineTitle}
            onChange={(v) => setFeature("browser", { searchEngine: v })}
            options={[...SEARCH_ENGINES.map((e) => ({ id: e.id, label: e.name })), { id: "custom" as const, label: cs.searchEngineCustom }]}
          />
        </SettingRow>
        {fs.browser?.searchEngine === "custom" && (
          <>
            <SettingRow title={cs.customSearchTitle} desc={cs.customSearchDesc}>
              <input
                type="text"
                spellCheck={false}
                aria-label={cs.customSearchTitle}
                aria-invalid={!!fs.browser?.customSearchUrl && !isValidSearchTemplate(fs.browser.customSearchUrl)}
                className={`${fieldInputClass} w-64 aria-[invalid=true]:border-red-500/70`}
                placeholder="https://example.com/search?q=%s"
                {...searchUrlField}
              />
            </SettingRow>
            <SettingRow title={cs.customSuggestTitle} desc={cs.customSuggestDesc}>
              <input
                type="text"
                spellCheck={false}
                aria-label={cs.customSuggestTitle}
                aria-invalid={!!fs.browser?.customSuggestUrl && !isValidSearchTemplate(fs.browser.customSuggestUrl)}
                className={`${fieldInputClass} w-64 aria-[invalid=true]:border-red-500/70`}
                placeholder="https://example.com/suggest?q=%s"
                {...suggestUrlField}
              />
            </SettingRow>
          </>
        )}
      </SettingGroup>
      <SettingGroup title={cs.fileEditorTitle}>
        <SettingRow title={cs.autoSaveTitle} desc={cs.autoSaveDesc}>
          <SettingsToggle
            checked={fs.files?.autoSave ?? true}
            onChange={(v) => setFeature("files", { autoSave: v })}
            label={cs.autoSaveTitle}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={cs.pullRequestsTitle}>
        <SettingRow title={cs.prCreateTitle} desc={cs.prCreateDesc}>
          <SettingsToggle
            checked={autoPr}
            onChange={(v) => setPr({ autoCreate: v })}
            label={cs.prCreateTitle}
          />
        </SettingRow>
        <SettingRow title={cs.prFixTitle} desc={cs.prFixDesc}>
          <SettingsToggle
            checked={autoFixPr}
            onChange={(v) => setPr({ autoFix: v })}
            label={cs.prFixTitle}
          />
        </SettingRow>
        <SettingRow title={cs.prArchiveTitle} desc={cs.prArchiveDesc}>
          <SettingsToggle
            checked={autoArchivePr}
            onChange={(v) => setPr({ autoArchive: v })}
            label={cs.prArchiveTitle}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
