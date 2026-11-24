import { useState, type Dispatch, type SetStateAction } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type Settings } from "@/lib/settings";
import { type PermissionRule } from "@/lib/permissions";
import { ConnectorDirectory, McpServersSection } from "./settings/ConnectorDirectory";
import { useTranslations } from "@/lib/i18n";
import { PluginsPanel } from "@/components/PluginsPanel";
import { AccountSection } from "./settings/AccountSection";
import { GeneralSettingsSection } from "./settings/GeneralSettingsSection";
import { AboutPage } from "./settings/AboutPage";
import { MusicSettingsSection } from "./settings/MusicSettingsSection";
import { PrivacySection } from "./settings/PrivacySection";
import { WorkspaceSettingsSection } from "./settings/WorkspaceSettingsSection";
import { CodeAppearanceSettings } from "./settings/CodeAppearanceSettings";
import { ComingSoonSettings } from "./settings/ComingSoonSettings";
import { LspSettingsSection, RagSettingsSection, WorkflowSettingsSection } from "./settings/CapabilitySettings";
import { PermissionRulesSection } from "./settings/PermissionRulesSection";
import { ProvidersSection } from "./settings/ProvidersSection";
import { Placeholder } from "./settings/settingsControls";
import { NAV, NAV_ICON, SECTION_LABEL_KEY, fold, type SectionId } from "./settings/settingsNav";

interface SettingsPanelProps {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onChange: Dispatch<SetStateAction<Settings>>;
  onWhatsNew?: () => void;
  rules?: PermissionRule[];
  onDeleteRule?: (index: number) => void;
  onClearRules?: () => void;
  workspace?: string | null;

  initialSection?: string;

  onSectionChange?: (sectionId: string) => void;
}

export function SettingsPanel({
  open,
  settings,
  onClose,
  onChange,
  rules = [],
  onDeleteRule,
  onClearRules,
  onWhatsNew,
  workspace,
  initialSection,
  onSectionChange,
}: SettingsPanelProps) {
  const t = useTranslations().settings;
  const [active, setActive] = useState<SectionId>("providers");
  const selectSection = (id: SectionId) => {
    setActive(id);
    onSectionChange?.(id);
  };
  // Opening on a given section picks it (again on every open), set while rendering, not in an effect.
  const wanted = open ? initialSection : undefined;
  const [shownFor, setShownFor] = useState(wanted);
  if (wanted !== shownFor) {
    setShownFor(wanted);
    if (wanted) setActive(wanted as SectionId);
  }
  const [query, setQuery] = useState("");

  if (!open) return null;

  const content = () => {
    switch (active) {
      case "general":
        return <GeneralSettingsSection />;

      case "acerca":
        return <AboutPage onWhatsNew={onWhatsNew} />;

      case "musica":
        return <MusicSettingsSection />;

      case "cuenta":
        return <AccountSection title={t.account} />;

      case "privacidad":
        return <PrivacySection title={t.privacy} workspace={workspace} />;

      case "conectores":
        return <McpServersSection />;

      case "extensiones":
        return <PluginsPanel />;

      case "code":
        return (
          <div className="space-y-8">
            <WorkspaceSettingsSection providerSettings={settings} workspace={workspace} />

            <CodeAppearanceSettings />

            <RagSettingsSection />

            <LspSettingsSection workspace={workspace} />

            <WorkflowSettingsSection workspace={workspace} />

            <ComingSoonSettings />

            <PermissionRulesSection rules={rules} onDeleteRule={onDeleteRule} onClearRules={onClearRules} />
          </div>
        );

      default: {
        return <Placeholder label={t[SECTION_LABEL_KEY[active]] as string} />;
      }
    }
  };

  const q = fold(query.trim());
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((it) => !q || fold(t[SECTION_LABEL_KEY[it.id]] as string).includes(q)) }))
    .filter((g) => g.items.length > 0);

  return (
    // A dialog over the app, like Claude's (the title bar stays free so the window can still be
    // moved; over an open website it waits for the page, or on Windows cuts a hole in it).
    // Claude's size: room for a provider's accounts and models without scrolling; on a smaller
    // window it fills what there is (the backdrop keeps a margin around it).
    <Dialog open onClose={onClose} className="max-w-[1240px] h-[min(900px,100%)] overflow-hidden">
        <DialogHeader className="h-11 pl-4 pr-4 pt-0 pb-0 border-b border-bg-300">
          <DialogTitle>{t.title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 min-h-0">
          <nav className="w-56 shrink-0 flex flex-col border-r border-bg-300">
            <div className="p-2.5 pb-1">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-400 pointer-events-none" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t.searchSettings}
                  aria-label={t.searchSettings}
                  spellCheck={false}
                  className="w-full h-8 pl-8 pr-2.5 rounded-md border border-bg-300 bg-bg-100 text-[13px] text-text-100 placeholder:text-text-500 outline-none focus:border-accent transition-colors"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar px-2.5 py-2 space-y-4">
              {groups.map((g, gi) => (
                <div key={gi}>
                  <p className="px-2 mb-1 text-[12px] text-text-400">{g.group ? t.desktopApp : t.title}</p>
                  <div className="space-y-0.5">
                    {g.items.map((it) => {
                      const Icon = NAV_ICON[it.id];
                      return (
                        <button
                          key={it.id}
                          onClick={() => selectSection(it.id)}
                          aria-current={active === it.id ? "page" : undefined}
                          className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13px] text-left transition-colors ${active === it.id ? "bg-bg-200 text-text-100" : "text-text-200 hover:bg-bg-200 hover:text-text-100"}`}
                        >
                          <Icon className="w-4 h-4 shrink-0 text-text-300" strokeWidth={1.75} />
                          <span className="flex-1 truncate">{t[SECTION_LABEL_KEY[it.id]] as string}</span>
                          {it.badge && <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase bg-bg-300 text-text-400">{it.badge}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </nav>

          {/* Providers lays out its own list and detail, each scrolling on its own. The other
              pages fill the same width with the same margins, so no page leaves an empty strip. */}
          {active === "providers" ? (
            <ProvidersSection settings={settings} onChange={onChange} />
          ) : (
            <div className="flex-1 min-w-0 overflow-y-auto custom-scrollbar px-8 py-7">{content()}</div>
          )}
        </div>
    </Dialog>
  );
}

export default SettingsPanel;

export { ConnectorDirectory, McpServersSection };
