import { useState } from "react";
import { Briefcase, Blocks, ScrollText, Puzzle } from "lucide-react";
import { ConnectorDirectory } from "./SettingsPanel";
import { PluginsPanel } from "./PluginsPanel";
import { SkillsDirectory } from "@/components/SkillsDirectory";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslations } from "@/lib/i18n";

type Tab = "skills" | "connectors" | "plugins";

type TabDef = {
  id: Tab;
  icon: typeof Briefcase;
  navKey: "connectorsNav" | "skillsNav" | "pluginsNav";
  titleKey: "connectorsTitle" | "skillsTitle" | "pluginsTitle";
  descKey: "connectorsDesc" | "skillsDesc" | "pluginsDesc";
};

const TABS: TabDef[] = [
  {
    id: "connectors",
    icon: Blocks,
    navKey: "connectorsNav",
    titleKey: "connectorsTitle",
    descKey: "connectorsDesc",
  },
  {
    id: "skills",
    icon: ScrollText,
    navKey: "skillsNav",
    titleKey: "skillsTitle",
    descKey: "skillsDesc",
  },
  {
    id: "plugins",
    icon: Puzzle,
    navKey: "pluginsNav",
    titleKey: "pluginsTitle",
    descKey: "pluginsDesc",
  },
];

export function CustomizePanel({ workspace }: { workspace: string | null }) {
  const [tab, setTab] = useState<Tab | null>(null);
  return (
    <>
      <Landing onPick={setTab} />
      {tab && (
        <DirectorioModal tab={tab} onTab={setTab} onClose={() => setTab(null)} workspace={workspace} />
      )}
    </>
  );
}

function Landing({ onPick }: { onPick: (t: Tab) => void }) {
  const t = useTranslations().customize;
  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="max-w-xl mx-auto px-6 py-16 flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-[8px] flex items-center justify-center text-text-200 mb-4">
          <Briefcase className="w-9 h-9" strokeWidth={1.25} />
        </div>
        <h1 className="text-2xl font-serif font-light text-text-100">{t.heading}</h1>
        <p className="text-sm text-text-400 mt-2 mb-8 max-w-md">
          {t.subtitle}
        </p>

        <div className="w-full space-y-3">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onPick(tab.id)}
              className="w-full flex items-center gap-4 text-left px-4 py-3.5 rounded-[8px] border border-bg-300 bg-bg-100 hover:bg-bg-200 hover:border-bg-300 transition-colors"
            >
              <span className="w-10 h-10 shrink-0 rounded-[8px] bg-bg-200 flex items-center justify-center text-text-300">
                <tab.icon className="w-5 h-5" strokeWidth={1.5} />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-text-100">{t[tab.titleKey]}</span>
                <span className="block text-[12.5px] text-text-400 mt-0.5">{t[tab.descKey]}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DirectorioModal({
  tab,
  onTab,
  onClose,
  workspace,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  workspace: string | null;
}) {
  const t = useTranslations().customize;
  return (
    <Dialog open onClose={onClose} stacked className="max-w-4xl h-[80vh] overflow-hidden">
      <DialogHeader className="px-6 pt-5 pb-3">
        <DialogTitle className="text-xl font-serif font-light">{t.directoryTitle}</DialogTitle>
      </DialogHeader>

      <div className="flex-1 flex min-h-0">
        <nav className="w-52 shrink-0 p-3 space-y-1">
          {TABS.map((it) => (
            <button
              key={it.id}
              onClick={() => onTab(it.id)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[6px] text-[13px] transition-colors ${
                tab === it.id ? "bg-bg-200 text-text-100" : "text-text-300 hover:bg-bg-200 hover:text-text-200"
              }`}
            >
              <it.icon className="w-4 h-4 text-text-400" />
              {t[it.navKey]}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
          {tab === "skills" && <SkillsDirectory workspace={workspace} />}
          {tab === "connectors" && <ConnectorDirectory />}
          {tab === "plugins" && <PluginsPanel />}
        </div>
      </div>
    </Dialog>
  );
}
