import { useState, useEffect, type ReactNode } from "react";
import { Check, Loader2, Download, Lock, Server, HardDrive, FolderOpen } from "lucide-react";
import { invoke } from "@/lib/ipc";
import { save } from "@tauri-apps/plugin-dialog";
import { userNyxsDir, userSettingsFile } from "@/lib/paths";
import { loadGlobalConfig } from "@/lib/globalConfig";
import { useTranslations } from "@/lib/i18n";
import { DEFAULT_SETTINGS } from "@/lib/configSchema";
import type { PrivacySettings } from "@/lib/privacySettings";
import { useSettings } from "@/lib/useSettings";
import { SectionTitle, SettingsToggle } from "./settingsControls";

function PrivacyInfoCard({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 p-4 rounded-lg border border-bg-300 bg-bg-100">
      <span className="shrink-0 w-9 h-9 rounded-md bg-accent/15 text-accent flex items-center justify-center">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-100">{title}</p>
        <p className="text-[12px] text-text-400 mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

/** One row of what goes to the Nyxs service: a switch, or a tag saying when it's sent. */
function ServiceRow({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-4 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-100">{title}</p>
        <p className="text-[12px] text-text-400 mt-0.5">{desc}</p>
      </div>
      {children}
    </li>
  );
}

function SentTag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-[6px] border border-bg-300 px-2 py-0.5 text-[11px] text-text-400">{children}</span>
  );
}

export function PrivacySection({ title }: { title: ReactNode }) {
  const p = useTranslations().settings.privacyPage;
  const { settings, perSource, update } = useSettings();
  // The user's own choices: the privacy switches are read from that layer only (privacySettings).
  const privacy: PrivacySettings = {
    ...DEFAULT_SETTINGS.privacy,
    ...((perSource.user as { privacy?: Partial<PrivacySettings> } | undefined)?.privacy ?? {}),
  };
  const setPrivacy = (key: keyof PrivacySettings, value: boolean) =>
    void update({ privacy: { [key]: value } } as Parameters<typeof update>[0], "user").catch(() => {});
  const promptSuggestions = (settings as { promptSuggestions?: boolean }).promptSuggestions ?? true;
  const [dataDir, setDataDir] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  useEffect(() => {
    void userNyxsDir().then(setDataDir).catch(() => {});
  }, []);

  const openPath = async () => {
    if (!dataDir) return;
    await invoke("agent_open_path", { path: dataDir }).catch(() => {});
  };

  const exportData = async () => {
    setExporting(true);
    try {
      const cfg = await loadGlobalConfig();
      let settings = "";
      try {
        settings = await invoke<string>("nyxs_read_text", { path: await userSettingsFile() });
      } catch {
        /* no settings file yet */
      }
      const payload = {
        exportedAt: new Date().toISOString(),
        app: "Nyxs",
        globalConfig: cfg,
        settings: settings.trim() ? JSON.parse(settings) : null,
      };
      const target = await save({
        defaultPath: "nyxs-data-export.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!target) return;
      await invoke("agent_write_file", {
        path: target,
        content: JSON.stringify(payload, null, 2) + "\n",
      });
      setExported(true);
      setTimeout(() => setExported(false), 2500);
    } catch {
      /* ignore — keep the button usable for a retry */
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-10">
      <SectionTitle>{title}</SectionTitle>

      <section className="space-y-3">
        <p className="text-sm text-text-300 leading-relaxed">{p.intro}</p>
        <div className="grid grid-cols-1 gap-3">
          <PrivacyInfoCard icon={<HardDrive className="w-[18px] h-[18px]" />} title={p.localFirstTitle} desc={p.localFirstDesc} />
          <PrivacyInfoCard icon={<Server className="w-[18px] h-[18px]" />} title={p.byokTitle} desc={p.byokDesc} />
          <PrivacyInfoCard icon={<Lock className="w-[18px] h-[18px]" />} title={p.noTrainingTitle} desc={p.noTrainingDesc} />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-text-100">{p.serviceHeading}</h3>
        <p className="text-[12px] text-text-400 mt-0.5 mb-2">{p.serviceIntro}</p>
        <ul className="divide-y divide-bg-300 border-t border-bg-300">
          <ServiceRow title={p.chatTitlesTitle} desc={p.chatTitlesDesc}>
            <SettingsToggle label={p.chatTitlesTitle} checked={privacy.chatTitles} onChange={(v) => setPrivacy("chatTitles", v)} />
          </ServiceRow>
          <ServiceRow title={p.suggestionsTitle} desc={p.suggestionsDesc}>
            <SettingsToggle
              label={p.suggestionsTitle}
              checked={promptSuggestions}
              onChange={(v) => void update({ promptSuggestions: v } as Parameters<typeof update>[0], "user").catch(() => {})}
            />
          </ServiceRow>
          <ServiceRow title={p.imagesTitle} desc={p.imagesDesc}>
            <SettingsToggle label={p.imagesTitle} checked={privacy.imageDescriptions} onChange={(v) => setPrivacy("imageDescriptions", v)} />
          </ServiceRow>
          <ServiceRow title={p.semanticTitle} desc={p.semanticDesc}>
            <SettingsToggle label={p.semanticTitle} checked={privacy.semanticSearch} onChange={(v) => setPrivacy("semanticSearch", v)} />
          </ServiceRow>
          <ServiceRow title={p.deviceTitle} desc={p.deviceDesc}>
            <SettingsToggle label={p.deviceTitle} checked={privacy.deviceDetails} onChange={(v) => setPrivacy("deviceDetails", v)} />
          </ServiceRow>
          <ServiceRow title={p.dictationTitle} desc={p.dictationDesc}>
            <SentTag>{p.whenUsed}</SentTag>
          </ServiceRow>
          <ServiceRow title={p.usageTitle} desc={p.usageDesc}>
            <SentTag>{p.always}</SentTag>
          </ServiceRow>
        </ul>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-text-100 mb-2">{p.yourData}</h3>
        <div className="rounded-lg border border-bg-300 bg-bg-100 divide-y divide-bg-300">
          <div className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-100">{p.exportTitle}</p>
              <p className="text-[12px] text-text-400 mt-0.5">{p.exportDesc}</p>
            </div>
            <button
              onClick={exportData}
              disabled={exporting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-bg-300 text-text-100 hover:bg-bg-200 disabled:opacity-60 transition-colors shrink-0"
            >
              {exporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : exported ? (
                <Check className="w-3.5 h-3.5 text-green-400" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              {exporting ? p.exporting : exported ? p.exportDone : p.exportButton}
            </button>
          </div>
          <div className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-100">{p.dataFolderTitle}</p>
              <p className="text-[12px] text-text-400 mt-0.5 font-mono truncate">{dataDir || "~/.nyxs"}</p>
            </div>
            <button
              onClick={openPath}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-bg-300 text-text-100 hover:bg-bg-200 transition-colors shrink-0"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              {p.openPath}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
