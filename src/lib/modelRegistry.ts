export interface RegistryModel {
  context?: number;
  output?: number;
  input?: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** models.dev lists image among the model's input modalities. */
  vision?: boolean;
  /** models.dev lists video among the model's input modalities. */
  video?: boolean;
}

type RegistryIndex = Record<string, Record<string, RegistryModel>>;

const REGISTRY_URL = "https://models.dev/api.json";
// v3 adds `video` (v2 added `vision`): an older cache lacks it, so it is refetched instead of read.
const STORAGE_KEY = "nyxs.modelRegistry.v3";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PROVIDER_ALIASES: Record<string, string[]> = {
  anthropic: ["anthropic"],
  "minimax-anthropic": ["minimax"],
  openai: ["openai"],
  google: ["google"],
  grok: ["xai"],
  "grok-cli": ["xai"],
  // Antigravity serves Google's, Anthropic's and OpenAI's models under its own names.
  "antigravity-cli": ["google", "anthropic", "openai"],
  "codex-cli": ["openai"],
  "deepseek-cli": ["deepseek"],
  // Cursor serves every lab's models, with a level in the name ("gpt-5.3-codex-high").
  "cursor-cli": ["openai", "anthropic", "google", "xai"],
  // Devin serves its own SWE models and other labs' ones.
  "devin-cli": ["anthropic", "openai", "google", "xai"],
  // OpenCode names its models "provider/model"; their provider part is models.dev's own.
  "opencode-cli": ["anthropic", "openai", "google", "xai", "deepseek"],
  deepseek: ["deepseek"],
  mistral: ["mistral"],
  qwen: ["alibaba"],
  moonshot: ["moonshotai"],
  minimax: ["minimax"],
  perplexity: ["perplexity"],
  groq: ["groq"],
  cerebras: ["cerebras"],
  together: ["togetherai"],
  fireworks: ["fireworks-ai"],
  deepinfra: ["deepinfra"],
  openrouter: ["openrouter"],
  vercel: ["vercel"],
  nvidia: ["nvidia"],
  zen: ["opencode"],
  "github-copilot": ["github-copilot"],
};

let index: RegistryIndex | null = null;
let loading: Promise<void> | null = null;

interface RawModel {
  limit?: { context?: number; output?: number; input?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  modalities?: { input?: string[] };
}

export function compactRegistry(raw: unknown): RegistryIndex {
  const out: RegistryIndex = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [providerId, provider] of Object.entries(raw as Record<string, { models?: Record<string, RawModel> }>)) {
    const models = provider?.models;
    if (!models || typeof models !== "object") continue;
    const slim: Record<string, RegistryModel> = {};
    for (const [modelId, m] of Object.entries(models)) {
      const entry: RegistryModel = {};
      if (m?.limit?.context) entry.context = m.limit.context;
      if (m?.limit?.output) entry.output = m.limit.output;
      if (m?.limit?.input) entry.input = m.limit.input;
      if (typeof m?.cost?.input === "number" && typeof m?.cost?.output === "number") {
        entry.cost = { input: m.cost.input, output: m.cost.output };
        if (typeof m.cost.cache_read === "number") entry.cost.cacheRead = m.cost.cache_read;
        if (typeof m.cost.cache_write === "number") entry.cost.cacheWrite = m.cost.cache_write;
      }
      if (Array.isArray(m?.modalities?.input)) {
        entry.vision = m.modalities.input.includes("image");
        entry.video = m.modalities.input.includes("video");
      }
      if (entry.context || entry.cost || entry.vision !== undefined) slim[modelId.toLowerCase()] = entry;
    }
    if (Object.keys(slim).length) out[providerId.toLowerCase()] = slim;
  }
  return out;
}

function readStored(): { at: number; data: RegistryIndex } | null {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; data?: RegistryIndex };
    if (!parsed?.data || typeof parsed.at !== "number") return null;
    return { at: parsed.at, data: parsed.data };
  } catch {
    return null;
  }
}

export function setRegistryIndex(data: RegistryIndex | null): void {
  index = data;
}

export function ensureModelRegistry(fetchImpl: typeof fetch): Promise<void> {
  if (loading) return loading;
  const stored = typeof window !== "undefined" ? readStored() : null;
  if (stored) index = stored.data;
  if (stored && Date.now() - stored.at < MAX_AGE_MS) return Promise.resolve();
  loading = (async () => {
    try {
      const res = await fetchImpl(REGISTRY_URL, { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = compactRegistry(await res.json());
      if (!Object.keys(data).length) return;
      index = data;
      try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), data }));
      } catch {
        /* storage full or unavailable: keep the in-memory copy */
      }
    } catch {
      /* offline: keep whatever we had */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function candidates(apiModel: string): string[] {
  // DeepSeek Harness names a model by its route: '["deepseek-official","deepseek-v4-pro"]'.
  const routed = /^\["[^"]*","([^"]+)"\]$/.exec(apiModel);
  const id = (routed ? routed[1] : apiModel).toLowerCase();
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const undated = tail.replace(/-\d{8}$/, "").replace(/-latest$/, "");
  // Antigravity names a model with its reasoning level ("gemini-3.8-flash-high", "claude-opus-4-6-thinking").
  const unleveled = undated.replace(/-(high|medium|low|thinking)$/, "");
  return [...new Set([id, tail, undated, unleveled])];
}

export function lookupRegistryModel(provider: string, apiModel: string): RegistryModel | null {
  if (!index || !apiModel) return null;
  const ids = candidates(apiModel);
  for (const p of PROVIDER_ALIASES[provider] ?? [provider]) {
    const models = index[p];
    if (!models) continue;
    for (const id of ids) if (models[id]) return models[id];
  }
  for (const id of ids.slice(1)) {
    for (const models of Object.values(index)) if (models[id]?.context) return models[id];
  }
  return null;
}

/** What a listing gives the prompt: the context, or the input limit when that is lower (models
 *  whose context counts the output too). */
function windowOf(m: RegistryModel | undefined): number | undefined {
  if (!m?.context) return undefined;
  return m.input ? Math.min(m.context, m.input) : m.context;
}

/** The context window models.dev gives the model. The provider's own entry decides; for a model
 *  it doesn't list (a custom endpoint, a reseller), the smallest among the hosts that list it,
 *  since the first one found may well be a host that serves it with more. */
export function registryContext(provider: string, apiModel: string): number | undefined {
  if (!index || !apiModel) return undefined;
  const ids = candidates(apiModel);
  for (const p of PROVIDER_ALIASES[provider] ?? [provider]) {
    const models = index[p];
    if (!models) continue;
    for (const id of ids) if (models[id]) return windowOf(models[id]);
  }
  for (const id of ids.slice(1)) {
    const windows = Object.values(index)
      .map((models) => windowOf(models[id]))
      .filter((w): w is number => !!w);
    if (windows.length) return Math.min(...windows);
  }
  return undefined;
}

/** Whether models.dev says the model takes images: true, false, or undefined when it doesn't know.
 *  The provider's own entry wins; otherwise (custom endpoints, resellers) the hosts that list the
 *  same model decide by majority, since they serve the same weights. */
export function registryVision(provider: string, apiModel: string): boolean | undefined {
  return registryModality(provider, apiModel, "vision");
}

/** Whether models.dev says the model takes video, decided like `registryVision`. */
export function registryVideo(provider: string, apiModel: string): boolean | undefined {
  return registryModality(provider, apiModel, "video");
}

type Modality = "vision" | "video";

function registryModality(provider: string, apiModel: string, key: Modality): boolean | undefined {
  if (!index || !apiModel) return undefined;
  const ids = candidates(apiModel);
  for (const p of PROVIDER_ALIASES[provider] ?? [provider]) {
    const models = index[p];
    if (!models) continue;
    for (const id of ids) if (models[id]?.[key] !== undefined) return models[id][key];
  }
  const byName = modalityByName(key);
  let known: boolean | undefined;
  for (const id of ids) {
    const name = bareName(id);
    // A short snapshot date (`-1017`) is tried only when the exact name isn't listed.
    const v = byName.get(name) ?? byName.get(name.replace(/-\d{4}$/, ""));
    if (v) return true;
    if (v === false) known = false;
  }
  return known;
}

/** `deepseek/deepseek-v4.1-flash-1017` → `deepseek-v4.1-flash-1017`, dropping the host's prefix
 *  and a trailing `-YYYYMMDD` / `-latest`, so one model matches across hosts. */
function bareName(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).replace(/:free$/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

const modalityIndexes: Record<Modality, { for: RegistryIndex | null; map: Map<string, boolean> }> = {
  vision: { for: null, map: new Map() },
  video: { for: null, map: new Map() },
};

/** A modality by bare model name across every host, by majority: a few hosts mislabel a text-only
 *  model as taking images (deepseek-v4-flash: 4 of ~70), so one "yes" isn't enough. Built once per index. */
function modalityByName(key: Modality): Map<string, boolean> {
  const cached = modalityIndexes[key];
  if (cached.for === index) return cached.map;
  const votes = new Map<string, { yes: number; no: number }>();
  for (const models of Object.values(index ?? {})) {
    for (const [id, m] of Object.entries(models)) {
      if (m[key] === undefined) continue;
      const name = bareName(id);
      const v = votes.get(name) ?? { yes: 0, no: 0 };
      if (m[key]) v.yes++;
      else v.no++;
      votes.set(name, v);
    }
  }
  const map = new Map<string, boolean>();
  for (const [name, v] of votes) map.set(name, v.yes > v.no);
  modalityIndexes[key] = { for: index, map };
  return map;
}
