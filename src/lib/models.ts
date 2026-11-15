import { type Settings } from "./settings";
import { registryContext, registryVideo, registryVision } from "./modelRegistry";

export type ProviderId =
  | "claude-code"
  | "grok-cli"
  | "antigravity-cli"
  | "cursor-cli"
  | "codex-cli"
  | "deepseek-cli"
  | "devin-cli"
  | "opencode-cli"
  | "openai"
  | "anthropic"
  | "google"
  | "grok"
  | "zen"
  | "github-copilot"
  | "openrouter"
  | "vercel"
  | "nvidia"
  | "deepseek"
  | "mistral"
  | "qwen"
  | "moonshot"
  | "minimax"
  | "minimax-anthropic"
  | "perplexity"
  | "groq"
  | "cerebras"
  | "together"
  | "fireworks"
  | "deepinfra"
  | "ollama"
  | "lmstudio"
  | "custom";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** `agent-cli`: another vendor's coding agent (Grok CLI, Antigravity CLI) run like Claude Code. */
  kind: "openai" | "anthropic" | "google" | "openai-compatible" | "claude-code" | "agent-cli";
  defaultBaseUrl?: string;
  keysUrl: string;
  description: string;
  logo?: string;
  /** The logo is a single-colour (black) glyph that must follow the text colour to stay visible in dark mode. */
  logoMono?: boolean;
  local?: boolean;
}

const LOBE_ICONS = "/provider-icons";

export interface ModelInfo {
  id: string;
  apiModel: string;
  name: string;
  description: string;
  provider: ProviderId;
  badge?: string;
  contextWindow?: number;
  effortLevels?: string[];
  /** Other ids the CLI may know this model by: Devin's session offers one id per group of
   *  variants, and which one it offers changes. */
  aliases?: string[];
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function getContextWindow(model: ModelInfo | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  return (
    model.contextWindow ??
    registryContext(model.provider, model.apiModel) ??
    cliFamilyContext(model) ??
    DEFAULT_CONTEXT_WINDOW
  );
}

/** For a CLI's model models.dev doesn't list yet (Antigravity names them its own way, like
 *  "gemini-3.8-flash-high"), the window its family has. */
function cliFamilyContext(model: ModelInfo): number | undefined {
  if (PROVIDERS[model.provider]?.kind !== "agent-cli") return undefined;
  const id = model.apiModel.toLowerCase();
  if (/gemini/.test(id)) return 1_048_576;
  if (/claude/.test(id)) return 200_000;
  if (/gpt-oss/.test(id)) return 131_072;
  if (/grok/.test(id)) return 256_000;
  return undefined;
}

/** Whether the model takes images natively. models.dev's data comes first, since it covers
 *  thousands of models; the name patterns below are the fallback for models it doesn't list.
 *  When this is false, attached images reach the model as a text description instead. */
export function supportsImages(model: ModelInfo | undefined): boolean {
  if (!model) return false;
  // Its "no" counts as much as its "yes": a text-only model named like a vision one must not
  // be sent images.
  const listed = registryVision(model.provider, model.apiModel);
  if (listed !== undefined) return listed;
  const id = model.apiModel.toLowerCase();
  switch (model.provider) {
    case "claude-code":
    case "grok-cli":
    case "cursor-cli":
    case "codex-cli":
      return true;
    // Its headless mode only takes text.
    case "antigravity-cli":
      return false;
    case "anthropic":
      return !/claude-(2|1|instant)/.test(id);
    case "google":
      return id.includes("gemini") && !/embedding|aqa|imagen/.test(id);
    case "openai":
      return (
        /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|chatgpt|o1|o3|o4|omni/.test(id) &&
        !/audio|realtime|tts|transcribe|moderation/.test(id)
      );
    case "zen":
    default:
      return /grok|gemini|gpt-4o|gpt-4\.1|gpt-5|claude|minimax-m3|vl|vision|multimodal|pixtral|llava|llama-?3\.2|llama-?4|maverick|scout|glm-4v|cogvlm|molmo|aria|phi-[34][\w-]*(?:vision|multimodal)/.test(id);
  }
}

/** Whether the model takes a whole video and Nyxs can send it one: Gemini through Google's API,
 *  and OpenAI-compatible endpoints (Qwen, MiniMax, Kimi...) as a `video_url` part (see
 *  `withToolMedia`). Other models watch a video as frames. An endpoint that turns the video down
 *  is remembered and gets frames from then on (`nativeVideoRejected`). */
export function supportsVideo(model: ModelInfo | undefined): boolean {
  if (!model) return false;
  const kind = PROVIDERS[model.provider]?.kind;
  if (kind !== "google" && kind !== "openai-compatible") return false;
  // NVIDIA's endpoints take the video but sample one frame of it and drop the sound: on
  // 2026-10-30 MiniMax M3.1 Flash there saw only the last of four on-screen words in 8 seconds,
  // and read all four from frames. Frames answer better there.
  if (model.provider === "nvidia") return false;
  if (registryVideo(model.provider, model.apiModel)) return true;
  const id = model.apiModel.toLowerCase();
  if (kind === "google") return id.includes("gemini") && !/embedding|aqa|imagen|tts|live/.test(id);
  return /gemini|qwen[\w.-]*(?:vl|omni)|qvq|qwen3\.[5-9]|minimax-m3|kimi-k2\.[5-9]/.test(id);
}

/** The key a model's video support is remembered under once its endpoint turns a video down. */
export function videoModelKey(model: ModelInfo): string {
  return `${model.provider}/${model.apiModel}`;
}

export function supportsPdf(model: ModelInfo | undefined): boolean {
  if (!model) return false;
  const id = model.apiModel.toLowerCase();
  switch (model.provider) {
    case "anthropic":
      return !/claude-(2|1|instant)/.test(id);
    case "google":
      return id.includes("gemini") && !/embedding|aqa|imagen/.test(id);
    case "openai":
      return /gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4/.test(id) && !/audio|realtime|tts|transcribe|moderation/.test(id);
    default:
      return false;
  }
}

export function supportsThinkingTypeParam(model: ModelInfo | undefined): boolean {
  if (!model) return false;
  const id = model.apiModel.toLowerCase();
  return /glm-4[.-][5-9]/.test(id) || /kimi-k2[.-][56]/.test(id);
}

export function supportsReasoningEffortParam(model: ModelInfo | undefined): boolean {
  if (!model) return false;
  return /minimax/i.test(model.apiModel);
}

/** How a Claude model takes thinking on Anthropic's API. `adaptive` (Claude 4.6 and later, Fable,
 *  Mythos): it decides how much to think and `effort` sets the depth; `budget_tokens` is turned
 *  down with a 400 from 4.7 on. `budget` (Claude 3.7 to 4.5): a fixed thinking budget. `xhigh`:
 *  the effort level between high and max, which arrived with Opus 4.7. */
export interface ClaudeThinking {
  mode: "adaptive" | "budget";
  xhigh: boolean;
}

/** null for a Claude model that can't think (3.5 and older) or an id that isn't Claude's. */
export function claudeThinking(apiModel: string): ClaudeThinking | null {
  const id = apiModel.toLowerCase();
  if (/claude-(fable|mythos)/.test(id)) return { mode: "adaptive", xhigh: true };
  // "claude-opus-4-6", "claude-sonnet-4-5-20250929", "claude-opus-4-20250514" (no minor: the
  // date isn't one), and the older order "claude-3-7-sonnet".
  const named = /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?=$|[-@:])/.exec(id);
  const legacy = /claude-(\d+)(?:[-.](\d))?-(?:opus|sonnet|haiku)/.exec(id);
  const version = named ?? legacy;
  if (!version) return null;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  const atLeast = (a: number, b: number) => major > a || (major === a && minor >= b);
  if (atLeast(4, 6)) return { mode: "adaptive", xhigh: atLeast(4, 7) };
  if (atLeast(3, 7)) return { mode: "budget", xhigh: false };
  return null;
}

/** Gemini 3 and later take `thinkingLevel`, which earlier models answer with an error; Gemini
 *  2.5 takes `thinkingBudget`. Image, speech and live models get no thinking options. */
export function geminiThinking(apiModel: string): "level" | "budget" | null {
  const id = apiModel.toLowerCase();
  if (/image|tts|embedding|aqa|live/.test(id)) return null;
  const version = /gemini-(\d+)/.exec(id);
  if (version && Number(version[1]) >= 3) return "level";
  return /gemini-2[.-]5|flash-thinking/.test(id) ? "budget" : null;
}

export function supportsThinking(model: ModelInfo | undefined): boolean {
  if (!model) return false;
  const id = model.apiModel.toLowerCase();
  switch (model.provider) {
    case "anthropic":
      return claudeThinking(id) !== null;
    case "google":
      return geminiThinking(id) !== null;
    case "openai":
      return /(^|[^a-z])(o1|o3|o4)|gpt-5/.test(id);
    default:
      return supportsThinkingTypeParam(model) || supportsReasoningEffortParam(model);
  }
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    kind: "claude-code",
    keysUrl: "https://code.claude.com/docs/en/setup",
    description: "Use your own Claude Pro or Max plan through the official Claude Code CLI",
    logo: `${LOBE_ICONS}/claude-color.svg`,
  },
  "grok-cli": {
    id: "grok-cli",
    name: "Grok CLI",
    kind: "agent-cli",
    keysUrl: "https://docs.x.ai/build/cli",
    description: "Use your own xAI account through the official Grok CLI",
    logo: `${LOBE_ICONS}/grok.svg`,
    logoMono: true,
  },
  "antigravity-cli": {
    id: "antigravity-cli",
    name: "Antigravity CLI",
    kind: "agent-cli",
    keysUrl: "https://antigravity.google/docs/install?tab=cli",
    description: "Use your own Google account through the official Antigravity CLI",
    logo: `${LOBE_ICONS}/antigravity-color.svg`,
  },
  "cursor-cli": {
    id: "cursor-cli",
    name: "Cursor CLI",
    kind: "agent-cli",
    keysUrl: "https://cursor.com/docs/cli/overview",
    description: "Use your own Cursor plan through the official Cursor CLI",
    logo: `${LOBE_ICONS}/cursor.svg`,
    logoMono: true,
  },
  "codex-cli": {
    id: "codex-cli",
    name: "Codex CLI",
    kind: "agent-cli",
    keysUrl: "https://developers.openai.com/codex/cli",
    description: "Use your own ChatGPT plan through OpenAI's official Codex CLI",
    logo: `${LOBE_ICONS}/openai.svg`,
    logoMono: true,
  },
  "deepseek-cli": {
    id: "deepseek-cli",
    name: "DeepSeek Harness",
    kind: "agent-cli",
    keysUrl: "https://platform.deepseek.com/api_keys",
    description: "DeepSeek's own coding agent, on your DeepSeek API key",
    logo: `${LOBE_ICONS}/deepseek.svg`,
  },
  "devin-cli": {
    id: "devin-cli",
    name: "Devin",
    kind: "agent-cli",
    keysUrl: "https://docs.devin.ai/cli",
    description: "Use your own Devin account through Cognition's official Devin CLI",
    logo: `${LOBE_ICONS}/devin.svg`,
    logoMono: true,
  },
  "opencode-cli": {
    id: "opencode-cli",
    name: "OpenCode",
    kind: "agent-cli",
    keysUrl: "https://opencode.ai/docs/cli/",
    description: "The open-source OpenCode agent, on the model providers you signed it in to",
    logo: `${LOBE_ICONS}/opencode.svg`,
    logoMono: true,
  },
  zen: {
    id: "zen",
    name: "OpenCode Zen",
    kind: "openai-compatible",
    defaultBaseUrl: "https://opencode.ai/zen/v1",
    keysUrl: "https://opencode.ai/auth",
    description: "Curated models including Claude, GPT, Gemini and more",
    logo: `${LOBE_ICONS}/opencode.svg`,
    logoMono: true,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    keysUrl: "https://console.anthropic.com/settings/keys",
    description: "Direct access to Claude models, including Pro and Max",
    logo: `${LOBE_ICONS}/anthropic.svg`,
    logoMono: true,
  },
  "github-copilot": {
    id: "github-copilot",
    name: "GitHub Copilot",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.githubcopilot.com",
    keysUrl: "https://github.com/settings/copilot",
    description: "AI models for coding assistance via GitHub Copilot",
    logo: `${LOBE_ICONS}/copilot.svg`,
    logoMono: true,
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    keysUrl: "https://platform.openai.com/api-keys",
    description: "OpenAI's GPT and o-series models",
    logo: `${LOBE_ICONS}/openai.svg`,
    logoMono: true,
  },
  google: {
    id: "google",
    name: "Google",
    kind: "google",
    keysUrl: "https://aistudio.google.com/apikey",
    description: "Gemini models for fast, structured responses",
    logo: `${LOBE_ICONS}/gemini-color.svg`,
  },
  grok: {
    id: "grok",
    name: "Grok (xAI)",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.x.ai/v1",
    keysUrl: "https://console.x.ai",
    description: "xAI's Grok models",
    logo: `${LOBE_ICONS}/grok.svg`,
    logoMono: true,
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keysUrl: "https://openrouter.ai/keys",
    description: "Access every supported model from a single provider",
    logo: `${LOBE_ICONS}/openrouter.svg`,
    logoMono: true,
  },
  vercel: {
    id: "vercel",
    name: "Vercel AI Gateway",
    kind: "openai-compatible",
    defaultBaseUrl: "https://ai-gateway.vercel.sh/v1",
    keysUrl: "https://vercel.com/dashboard/ai-gateway",
    description: "Unified access to AI models with smart routing",
    logo: `${LOBE_ICONS}/vercel.svg`,
    logoMono: true,
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA",
    kind: "openai-compatible",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    keysUrl: "https://build.nvidia.com",
    description: "NVIDIA-hosted models: Llama, DeepSeek, Qwen and more",
    logo: `${LOBE_ICONS}/nvidia.svg`,
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.deepseek.com",
    keysUrl: "https://platform.deepseek.com/api_keys",
    description: "DeepSeek's chat and reasoning models",
    logo: `${LOBE_ICONS}/deepseek.svg`,
  },
  mistral: {
    id: "mistral",
    name: "Mistral AI",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    keysUrl: "https://console.mistral.ai/api-keys",
    description: "Mistral's open and frontier models",
    logo: `${LOBE_ICONS}/mistral.svg`,
  },
  qwen: {
    id: "qwen",
    name: "Qwen (Alibaba)",
    kind: "openai-compatible",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keysUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    description: "Alibaba's Qwen models via DashScope",
    logo: `${LOBE_ICONS}/qwen.svg`,
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
    description: "Moonshot's long-context Kimi models",
    logo: `${LOBE_ICONS}/moonshot.svg`,
    logoMono: true,
  },
  minimax: {
    id: "minimax",
    name: "MiniMax",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.minimax.io/v1",
    keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    description: "MiniMax M-series reasoning models (M2, M2.5, M3…)",
    logo: `${LOBE_ICONS}/minimax-color.svg`,
  },
  "minimax-anthropic": {
    id: "minimax-anthropic",
    name: "MiniMax (Anthropic)",
    kind: "anthropic",
    defaultBaseUrl: "https://api.minimax.io/anthropic/v1",
    keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    description: "MiniMax M-series over the Anthropic protocol (prompt caching)",
    logo: `${LOBE_ICONS}/minimax-color.svg`,
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.perplexity.ai",
    keysUrl: "https://www.perplexity.ai/settings/api",
    description: "Sonar models with built-in web search",
    logo: `${LOBE_ICONS}/perplexity.svg`,
  },
  groq: {
    id: "groq",
    name: "Groq",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    keysUrl: "https://console.groq.com/keys",
    description: "Ultra-fast inference for open models",
    logo: `${LOBE_ICONS}/groq.svg`,
    logoMono: true,
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    keysUrl: "https://cloud.cerebras.ai",
    description: "Fastest inference for Llama and Qwen",
    logo: `${LOBE_ICONS}/cerebras.svg`,
  },
  together: {
    id: "together",
    name: "Together AI",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.together.xyz/v1",
    keysUrl: "https://api.together.ai/settings/api-keys",
    description: "Open models from a single API",
    logo: `${LOBE_ICONS}/together.svg`,
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks AI",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    keysUrl: "https://fireworks.ai/account/api-keys",
    description: "Fast hosting for open models",
    logo: `${LOBE_ICONS}/fireworks.svg`,
  },
  deepinfra: {
    id: "deepinfra",
    name: "DeepInfra",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    keysUrl: "https://deepinfra.com/dash/api_keys",
    description: "Affordable hosting for open models",
    logo: `${LOBE_ICONS}/deepinfra.svg`,
    logoMono: true,
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    kind: "openai-compatible",
    defaultBaseUrl: "http://localhost:11434/v1",
    keysUrl: "",
    description: "Run open models locally with Ollama",
    logo: `${LOBE_ICONS}/ollama.svg`,
    logoMono: true,
    local: true,
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    kind: "openai-compatible",
    defaultBaseUrl: "http://localhost:1234/v1",
    keysUrl: "",
    description: "Run open models locally with LM Studio",
    logo: `${LOBE_ICONS}/lmstudio.svg`,
    logoMono: true,
    local: true,
  },
  custom: {
    id: "custom",
    name: "Custom provider",
    kind: "openai-compatible",
    keysUrl: "",
    description: "Add an OpenAI-compatible provider by its base URL",
  },
};

/** Providers whose models run inside their vendor's own CLI (Claude Code, Grok CLI,
 *  Antigravity CLI): only the chat can drive them, never Nyxs' own model client. */
export function runsInCli(provider: ProviderId): boolean {
  return provider === "claude-code" || PROVIDERS[provider]?.kind === "agent-cli";
}

export interface ModelLogo {
  logo?: string;
  logoMono?: boolean;
}

/** The lab behind a model, told from its id or name ("qwen/qwen3-32b", "DeepSeek-V3",
 *  "meta-llama/Llama-3.3-70B"). More specific families come first: gemma before gemini,
 *  everyone before the loose GPT/o-series pattern. */
const MODEL_FAMILIES: { test: RegExp; logo: string; mono?: boolean }[] = [
  { test: /claude|anthropic/, logo: "claude-color.svg" },
  { test: /deepseek/, logo: "deepseek.svg" },
  { test: /qwen|qwq|qvq/, logo: "qwen.svg" },
  { test: /kimi|moonshot/, logo: "moonshot.svg", mono: true },
  { test: /glm|zhipu|z-ai|\bzai\b/, logo: "zhipu-color.svg" },
  { test: /minimax|abab/, logo: "minimax-color.svg" },
  { test: /gemma/, logo: "gemma-color.svg" },
  { test: /gemini|^google\//, logo: "gemini-color.svg" },
  { test: /grok|x-ai|\bxai\b/, logo: "grok.svg", mono: true },
  { test: /llama|^meta[-/]/, logo: "meta-color.svg" },
  { test: /mistral|mixtral|codestral|devstral|magistral|ministral|pixtral|voxtral/, logo: "mistral.svg" },
  { test: /command-|cohere|\baya\b/, logo: "cohere-color.svg" },
  { test: /\bphi-?\d|microsoft/, logo: "microsoft-color.svg" },
  { test: /nemotron|nvidia/, logo: "nvidia.svg" },
  { test: /doubao|bytedance|seed-?\d/, logo: "doubao-color.svg" },
  { test: /hunyuan|tencent/, logo: "hunyuan-color.svg" },
  { test: /ernie|wenxin|baidu/, logo: "wenxin-color.svg" },
  { test: /01-ai|\byi-/, logo: "yi-color.svg" },
  { test: /stepfun|\bstep-\d/, logo: "stepfun-color.svg" },
  { test: /hermes|nous/, logo: "nousresearch.svg", mono: true },
  { test: /internlm|intern-?s1/, logo: "internlm-color.svg" },
  { test: /mimo|xiaomi/, logo: "xiaomimimo.svg", mono: true },
  { test: /granite|ibm/, logo: "ibm.svg", mono: true },
  { test: /olmo|tulu|allenai|\bai2\b/, logo: "ai2-color.svg" },
  { test: /longcat|meituan/, logo: "longcat-color.svg" },
  { test: /arcee/, logo: "arcee-color.svg" },
  { test: /\blfm|liquid/, logo: "liquid.svg", mono: true },
  { test: /baichuan/, logo: "baichuan-color.svg" },
  { test: /jamba|ai21/, logo: "ai21.svg", mono: true },
  { test: /sonar|perplexity/, logo: "perplexity.svg" },
  { test: /openai|chatgpt|codex|davinci|(^|[/\s:-])(gpt|o[1-9])(\b|-|$)/, logo: "openai.svg", mono: true },
];

/** The logo of the lab that made a model, when its id or name says which. */
export function modelFamilyLogo(model: Pick<ModelInfo, "apiModel" | "name">): ModelLogo | null {
  const text = `${model.apiModel} ${model.name}`.toLowerCase();
  const family = MODEL_FAMILIES.find((f) => f.test.test(text));
  return family ? { logo: `${LOBE_ICONS}/${family.logo}`, logoMono: family.mono } : null;
}

/** The icon shown before a model's name: its provider's logo, or for a provider without one
 *  (a custom endpoint) the logo of the model's lab. */
export function modelLogo(model: ModelInfo): ModelLogo {
  const provider = PROVIDERS[model.provider];
  if (provider?.logo) return { logo: provider.logo, logoMono: provider.logoMono };
  return modelFamilyLogo(model) ?? {};
}

export const PROVIDER_ORDER: ProviderId[] = [
  "claude-code",
  "grok-cli",
  "antigravity-cli",
  "cursor-cli",
  "codex-cli",
  "deepseek-cli",
  "devin-cli",
  "opencode-cli",
  "zen",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "grok",
  "deepseek",
  "mistral",
  "qwen",
  "moonshot",
  "minimax",
  "minimax-anthropic",
  "perplexity",
  "openrouter",
  "vercel",
  "nvidia",
  "groq",
  "cerebras",
  "together",
  "fireworks",
  "deepinfra",
  "ollama",
  "lmstudio",
  "custom",
];

function hasApiKey(settings: Settings, id: ProviderId): boolean {
  return Boolean(settings[id]?.apiKey?.trim());
}

/** A model's name without the path some providers give it ("minimaxai/minimax-m3.1-flash",
 *  "accounts/fireworks/models/llama-v3") — the lab shows in its logo instead. A real display
 *  name ("Claude Opus 4") is left as it is. */
export function modelDisplayName(name: string): string {
  if (/\s/.test(name)) return name;
  return name.slice(name.lastIndexOf("/") + 1) || name;
}

export function getActiveModels(settings: Settings): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const cfg = settings[id];
    if (!cfg || !hasApiKey(settings, id) || !cfg.models?.length) continue;
    const enabled = new Set(cfg.enabled ?? []);
    // The stand-in a CLI gets when its list couldn't be read ("default") is left out once
    // real models are listed beside it.
    const real = cfg.models.some((m) => m.apiModel !== "default");
    for (const m of cfg.models) {
      if (PROVIDERS[id].kind === "agent-cli" && real && m.apiModel === "default") continue;
      if (enabled.has(m.id)) out.push({ ...withUserWindow(m, cfg), name: modelDisplayName(m.name) });
    }
  }
  return out;
}

/** A model with the context window the user set for it in Manage models, which wins over what
 *  the provider or models.dev say. Kept apart from the model list, which every refresh replaces. */
function withUserWindow(model: ModelInfo, cfg: Settings[ProviderId] | undefined): ModelInfo {
  const set = cfg?.contextWindows?.[model.id];
  return set && set > 0 ? { ...model, contextWindow: set } : model;
}

export const MODEL_ALIASES: Record<string, RegExp> = {
  opus: /opus/i,
  sonnet: /sonnet/i,
  haiku: /haiku/i,
  gpt: /\bgpt|o[34]\b/i,
  gemini: /gemini/i,
  grok: /grok/i,
  llama: /llama/i,
  deepseek: /deepseek/i,
  qwen: /qwen/i,
};

export function resolveModelAlias(id: string, settings: Settings): string {
  const matcher = MODEL_ALIASES[id.trim().toLowerCase()];
  if (!matcher) return id;
  const pickLatest = (models: ModelInfo[]): ModelInfo | undefined =>
    models
      .filter((m) => matcher.test(m.id))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
  const fromActive = pickLatest(getActiveModels(settings));
  if (fromActive) return fromActive.id;
  const allLoaded: ModelInfo[] = [];
  for (const cfg of Object.values(settings)) if (cfg?.models) allLoaded.push(...cfg.models);
  return pickLatest(allLoaded)?.id ?? id;
}

export function getModel(id: string, settings: Settings): ModelInfo | undefined {
  const resolved = resolveModelAlias(id, settings);
  for (const cfg of Object.values(settings)) {
    const found = cfg.models?.find((m) => m.id === resolved);
    if (found) return withUserWindow(found, cfg);
  }
  return undefined;
}
