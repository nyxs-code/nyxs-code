import { useTranslations } from "@/lib/i18n";
import { useSettings } from "@/lib/useSettings";
import { SettingRow, SettingsToggle } from "./settingsControls";

export function RagSettingsSection() {
  const { settings, update } = useSettings();
  const t = useTranslations();
  const rag = (settings as { rag?: Partial<RagConfigShape> }).rag ?? {};
  const enabled = rag.enabled ?? true;

  const setEnabled = (v: boolean) =>
    update({ rag: { enabled: v } } as Parameters<typeof update>[0], "user");

  return (
    <div className="border-t border-bg-300">
      <SettingRow title={t.ragSettings.title} desc={t.ragSettings.desc}>
        <SettingsToggle checked={enabled} onChange={setEnabled} label={t.ragSettings.enable} />
      </SettingRow>
    </div>
  );
}

interface LspConfigShape {
  enabled: boolean;
  autoInstall: boolean;
  diagnosticsWaitMs: number;
}

interface WorkflowConfigShape { enabled: boolean; maxAgents: number }

export function WorkflowSettingsSection(_props: { workspace?: string | null }) {
  const c = useTranslations().settings.capabilitiesPage;
  const { settings, update } = useSettings();
  const wf = (settings as { workflow?: Partial<WorkflowConfigShape> }).workflow ?? {};
  const enabled = wf.enabled ?? false;
  const maxAgents = wf.maxAgents ?? 12;

  // Only the change goes in: the merged view holds the project's values too, which mustn't be
  // copied into the user's settings (they are deep-merged).
  const setWf = (patch: Partial<WorkflowConfigShape>) =>
    update({ workflow: patch } as Parameters<typeof update>[0], "user");

  return (
    <div className="border-t border-bg-300">
      <SettingRow
        title={c.workflowTitle}
        desc={c.workflowDesc}
      >
        <SettingsToggle checked={enabled} onChange={(v) => setWf({ enabled: v })} label={c.workflowEnable} />
      </SettingRow>

      {enabled && (
        <div className="border-t border-bg-300">
          <SettingRow
            title={c.workflowMaxAgents}
            desc={c.workflowMaxAgentsDesc}
          >
            <input
              type="number"
              min={1}
              max={50}
              value={maxAgents}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!isNaN(n)) setWf({ maxAgents: Math.min(50, Math.max(1, n)) });
              }}
              className="w-20 shrink-0 px-3 py-2 text-sm rounded-md bg-bg-200 border border-bg-300 text-text-100 outline-none focus:border-accent"
            />
          </SettingRow>
        </div>
      )}
    </div>
  );
}

export function LspSettingsSection(_props: { workspace?: string | null }) {
  const c = useTranslations().settings.capabilitiesPage;
  const { settings, update } = useSettings();
  const lsp = (settings as { lsp?: Partial<LspConfigShape> }).lsp ?? {};
  const enabled = lsp.enabled ?? true;

  const setLsp = (patch: Partial<LspConfigShape>) =>
    update({ lsp: patch } as Parameters<typeof update>[0], "user");

  return (
    <div className="border-t border-bg-300">
      <SettingRow
        title={c.lspTitle}
        desc={c.lspDesc}
      >
        <SettingsToggle checked={enabled} onChange={(v) => setLsp({ enabled: v })} label={c.lspEnable} />
      </SettingRow>
    </div>
  );
}

interface RagConfigShape {
  enabled: boolean;
  embeddingModel: string;
  topK: number;
  maxFileSize: number;
  autoIndex: boolean;
  provider: "backend" | "mock";
}
