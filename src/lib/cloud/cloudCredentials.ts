import { PROVIDERS, type ProviderId } from "@/lib/models";
import type { Settings } from "@/lib/settings";

// Which of the user's providers can run in the Nyxs cloud, under which credential name, and the
// settings a cloud thread gets (docs/proyectos-nube-spec.md, "PUT /secrets").

/** The cloud name of a provider's API key: `<ID>_API_KEY`, the env var the turn gets it in, which
 *  the worker reads as Nyxs's keychain entry (`headless.rs` `secret_env_names`) and most vendors'
 *  own tools read too. */
export const providerCloudKey = (id: ProviderId): string => `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

/** What an agent CLI signs in with in the cloud. Claude Code: a long-lived token from `claude
 *  setup-token`, pasted in Settings › Nube. Codex: the OpenAI API key, because its ChatGPT
 *  sign-in renews itself and a copy in the cloud would sign this computer out. */
export const CLI_CLOUD_KEYS = {
  "claude-code": "CLAUDE_CODE_OAUTH_TOKEN",
  "codex-cli": "OPENAI_API_KEY",
} as const satisfies Partial<Record<ProviderId, string>>;
/** The token the worker clones, pushes and opens pull requests with. */
export const GITHUB_CLOUD_KEY = "GITHUB_TOKEN";

export type CloudSupport =
  | { ok: true; key: string }
  | { ok: false; reason: "local" | "cli" };

const LOCAL_HOST = /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/** Whether a provider can work in the cloud, and the credential it needs there. A provider on
 *  this computer or its network (Ollama, LM Studio, a local base URL) can't: the cloud container
 *  can't reach it. Agent CLIs other than Claude Code and Codex aren't in the worker image yet. */
export function cloudSupport(id: ProviderId, settings?: Settings): CloudSupport {
  const info = PROVIDERS[id];
  const baseUrl = settings?.[id]?.baseUrl ?? info.defaultBaseUrl ?? "";
  if (info.local || (baseUrl && LOCAL_HOST.test(baseUrl))) return { ok: false, reason: "local" };
  if (id in CLI_CLOUD_KEYS) return { ok: true, key: CLI_CLOUD_KEYS[id as keyof typeof CLI_CLOUD_KEYS] };
  if (info.kind === "agent-cli" || info.kind === "claude-code") return { ok: false, reason: "cli" };
  return { ok: true, key: providerCloudKey(id) };
}

/** The provider API keys on this computer that can go to the cloud, for the providers the user
 *  chose to sync. The Claude Code token and the GitHub token aren't here: the user pastes them. */
export function providerKeysForCloud(settings: Settings, chosen: Iterable<ProviderId>): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const id of chosen) {
    const value = settings[id]?.apiKey?.trim();
    const support = cloudSupport(id, settings);
    if (!value || !support.ok || support.key !== providerCloudKey(id)) continue;
    out.push({ key: support.key, value });
  }
  return out;
}

/** The user's provider settings without any key and without the providers the cloud can't
 *  reach: base URLs, models, enabled models and context windows. */
export function sanitizedCloudSettings(settings: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(settings) as ProviderId[]) {
    if (!PROVIDERS[id] || !cloudSupport(id, settings).ok) continue;
    const { apiKey: _key, ...rest } = settings[id];
    out[id] = rest;
  }
  return { providers: out };
}
