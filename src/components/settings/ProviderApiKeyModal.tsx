import { useState, useRef } from "react";
import { Eye, EyeOff, ExternalLink, Server } from "lucide-react";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { PROVIDERS, type ProviderId } from "@/lib/models";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslations } from "@/lib/i18n";

const PROVIDER_COLOR: Partial<Record<ProviderId, string>> = {
  anthropic: "#d97757",
  "claude-code": "#d97757",
  "grok-cli": "#e5e5e5",
  "antigravity-cli": "#4285f4",
  "cursor-cli": "#e5e5e5",
  "codex-cli": "#10a37f",
  "deepseek-cli": "#4d6bfe",
  "devin-cli": "#e5e5e5",
  "opencode-cli": "#e5e5e5",
  openai: "#10a37f",
  google: "#4285f4",
  zen: "#a78bfa",
  grok: "#e5e5e5",
  "github-copilot": "#e5e5e5",
  openrouter: "#7c8aff",
  vercel: "#e5e5e5",
  nvidia: "#76b900",
  deepseek: "#4d6bfe",
  mistral: "#fa520f",
  qwen: "#615ced",
  moonshot: "#16191e",
  perplexity: "#20808d",
  groq: "#f55036",
  cerebras: "#f15a29",
  together: "#0f6fff",
  fireworks: "#7c3aed",
  deepinfra: "#4d40ff",
  ollama: "#e5e5e5",
  lmstudio: "#7c5cff",
  custom: "#94a3b8",
};

export function ProviderIcon({ id, small = false }: { id: ProviderId; small?: boolean }) {
  const provider = PROVIDERS[id];
  const color = PROVIDER_COLOR[id] ?? "#94a3b8";
  const [failed, setFailed] = useState(false);
  const showLogo = provider.logo && !failed;
  const isCustom = id === "custom";
  return (
    <span
      className={`${small ? "w-6 h-6 rounded-[6px] text-xs" : "w-8 h-8 rounded-[8px] text-sm"} shrink-0 flex items-center justify-center font-bold overflow-hidden`}
      style={
        isCustom
          ? { backgroundColor: "#ffffff", color: "#1a1a19" }
          : { backgroundColor: showLogo ? "#ffffff" : `${color}22`, color }
      }
    >
      {isCustom ? (
        <Server className={small ? "w-3.5 h-3.5" : "w-[18px] h-[18px]"} strokeWidth={1.8} aria-hidden="true" />
      ) : showLogo ? (
        <img
          src={provider.logo}
          alt=""
          className={`${small ? "w-4 h-4" : "w-5 h-5"} object-contain`}
          onError={() => setFailed(true)}
        />
      ) : (
        provider.name.charAt(0).toUpperCase()
      )}
    </span>
  );
}

interface ProviderApiKeyModalProps {
  providerId: ProviderId;
  apiKey: string;
  baseUrl: string;
  /** Anthropic only: the workspace an organization-scoped key acts in. */
  workspaceId: string;
  reveal: boolean;
  customProviderLabel: string;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onWorkspaceIdChange: (value: string) => void;
  onRevealToggle: () => void;
  onSave: () => void;
  onClose: () => void;
}

export function ProviderApiKeyModal({
  providerId,
  apiKey,
  baseUrl,
  workspaceId,
  reveal,
  customProviderLabel,
  onApiKeyChange,
  onBaseUrlChange,
  onWorkspaceIdChange,
  onRevealToggle,
  onSave,
  onClose,
}: ProviderApiKeyModalProps) {
  const t = useTranslations().settings;
  const provider = PROVIDERS[providerId];
  const displayName = providerId === "custom" ? customProviderLabel : provider.name;
  const isLocal = !!provider.local;
  // The key, or the address for a local provider.
  const focusRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog open onClose={onClose} stacked initialFocus={focusRef} className="overflow-y-auto custom-scrollbar">
      <DialogHeader className="px-5 pt-5 pb-0">
        <ProviderIcon id={providerId} />
        <DialogTitle className="text-base font-semibold truncate">{displayName}</DialogTitle>
      </DialogHeader>
      <div className="px-5 pt-4 pb-5 space-y-4">
        <p className="text-[12px] text-text-400">{isLocal ? t.localNoKey : t.pasteApiKey}</p>

        {!isLocal && provider.keysUrl && (
          <a
            href={provider.keysUrl}
            onClick={handleExternalLinkClick}
            rel="noreferrer"
            className="text-[12px] text-accent hover:underline inline-flex items-center gap-1"
          >
            {t.getKey} <ExternalLink className="w-3 h-3" />
          </a>
        )}

        {!isLocal && (
          <div>
            <label htmlFor="provider-api-key-input" className="sr-only">
              {t.apiKey}
            </label>
            <div className="relative">
              <input
                id="provider-api-key-input"
                type={reveal ? "text" : "password"}
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apiKey.trim() && onSave()}
                placeholder={`${displayName} ${t.apiKey}`}
                ref={isLocal ? undefined : focusRef}
                className="w-full pr-10 px-3 py-2 text-sm rounded-[6px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono"
              />
              <button
                type="button"
                onClick={onRevealToggle}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-400 hover:text-text-200"
                aria-label={reveal ? t.hideApiKey : t.showApiKey}
              >
                {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        )}

        {providerId === "anthropic" && (
          <div>
            <label htmlFor="provider-workspace-id-input" className="mb-1.5 block text-[12px] text-text-400">
              {t.workspaceId}
            </label>
            <input
              id="provider-workspace-id-input"
              type="text"
              value={workspaceId}
              onChange={(e) => onWorkspaceIdChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apiKey.trim() && onSave()}
              placeholder={t.workspaceIdPlaceholder}
              spellCheck={false}
              className="w-full px-3 py-2 text-xs rounded-[6px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent font-mono"
            />
            <p className="mt-1.5 text-[11px] text-text-400">{t.workspaceIdHint}</p>
          </div>
        )}

        {(providerId === "custom" || isLocal) && (
          <div>
            <label htmlFor="provider-base-url-input" className="sr-only">
              {t.baseUrlPlaceholder}
            </label>
            <input
              id="provider-base-url-input"
              type="text"
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && isLocal && onSave()}
              placeholder={provider.defaultBaseUrl ?? t.baseUrlPlaceholder}
              ref={isLocal ? focusRef : undefined}
              className="w-full px-3 py-2 text-xs rounded-[6px] bg-bg-200 border border-bg-300 text-text-300 placeholder:text-text-400 outline-none focus:border-accent font-mono"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t.cancel}</Button>
          <Button variant="primary" onClick={onSave} disabled={!isLocal && !apiKey.trim()}>
            {t.connect}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
