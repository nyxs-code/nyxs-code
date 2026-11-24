import { z } from "zod";

export const DEFAULT_MODEL = "claude-opus-4-8";

export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

export const PERMISSION_MODES = ["ask", "acceptEdits", "plan", "auto", "skip"] as const;
export const permissionModeSchema = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const themeSchema = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof themeSchema>;

export const permissionsSchema = z
  .object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
  })
  .default({ allow: [], deny: [], ask: [] });

export const hookCommandSchema = z.object({
  type: z.literal("command"),
  command: z.string(),
  timeout: z.number().int().positive().optional(),
});

export const hookMatcherSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(hookCommandSchema),
});

export const hooksSchema = z.record(z.string(), z.array(hookMatcherSchema)).default({});

const mcpStdioServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),

  enabled: z.boolean().default(true),
});

const mcpRemoteServerSchema = z.object({
  type: z.enum(["sse", "http"]).default("http"),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),

  enabled: z.boolean().default(true),

  oauthClientId: z.string().optional(),
});

export const mcpServerSchema = z.union([mcpStdioServerSchema, mcpRemoteServerSchema]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const mcpServersSchema = z.record(z.string(), mcpServerSchema).default({});

export const envSchema = z.record(z.string(), z.string()).default({});

export const marketplacesSchema = z.record(z.string(), z.string()).default({});

export const enabledPluginsSchema = z.array(z.string()).default([]);

export const diagnosticRuleSchema = z.object({

  match: z.string(),

  command: z.string(),

  detect: z.string().optional(),

  scope: z.enum(["all", "file"]).optional(),
});

export const diagnosticsSchema = z
  .object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(30_000),
    maxOutputChars: z.number().int().positive().default(4_000),
    rules: z.array(diagnosticRuleSchema).default([]),

    autoFix: z.boolean().default(true),

    autoFixMaxAttempts: z.number().int().positive().default(3),

    showInUi: z.boolean().default(false),
  })
  .default({
    enabled: true,
    timeoutMs: 30_000,
    maxOutputChars: 4_000,
    rules: [],
    autoFix: true,
    autoFixMaxAttempts: 3,
    showInUi: false,
  });

export const ragSchema = z
  .object({

    enabled: z.boolean().default(true),

    embeddingModel: z.string().min(1).default("nvidia/nv-embedqa-e5-v5"),

    topK: z.number().int().positive().max(50).default(8),

    maxFileSize: z.number().int().positive().default(1_500_000),

    autoIndex: z.boolean().default(true),

    provider: z.enum(["backend", "mock"]).default("backend"),
  })
  .default({
    enabled: true,
    embeddingModel: "text-embedding-3-small",
    topK: 8,
    maxFileSize: 1_500_000,
    autoIndex: true,
    provider: "backend",
  });

export const lspSchema = z
  .object({

    enabled: z.boolean().default(true),

    autoInstall: z.boolean().default(true),

    diagnosticsWaitMs: z.number().int().positive().default(1_500),
  })
  .default({
    enabled: true,
    autoInstall: true,
    diagnosticsWaitMs: 1_500,
  });

export const workflowSchema = z
  .object({

    enabled: z.boolean().default(false),

    maxAgents: z.number().int().positive().max(50).default(12),
  })
  .default({ enabled: false, maxAgents: 12 });

export const generationSchema = z
  .object({

    maxOutputTokens: z.number().int().min(1024).max(200_000).default(32_768),

    subagentMaxSteps: z.number().int().min(5).max(200).default(200),
  })
  .default({ maxOutputTokens: 32_768, subagentMaxSteps: 200 });

export const worktreeSchema = z
  .object({

    location: z.string().default(""),

    branchPrefix: z.string().default("Nyxs"),

    isolateSubagents: z.boolean().default(false),
  })
  .default({ location: "", branchPrefix: "Nyxs", isolateSubagents: false });

export const pullRequestsSchema = z
  .object({

    autoCreate: z.boolean().default(false),

    autoFix: z.boolean().default(false),

    autoArchive: z.boolean().default(false),
  })
  .default({ autoCreate: false, autoFix: false, autoArchive: false });

export const SETTINGS_FIELDS = {

  model: z.string().min(1).default(DEFAULT_MODEL),

  theme: themeSchema.default("system"),

  language: z.string().min(1).default("en"),

  defaultPermissionMode: permissionModeSchema.default("ask"),

  allowPermissionBypass: z.boolean().default(false),

  allowPreview: z.boolean().default(true),
  allowVideoTools: z.boolean().default(true),

  // The Computer tool: the agent sees the screen and uses the mouse and keyboard.
  allowComputerUse: z.boolean().default(false),

  // The connectors of the user's claude.ai account inside Claude Code runs.
  claudeAiConnectors: z.boolean().default(false),

  classifySessionStates: z.boolean().default(false),

  promptSuggestions: z.boolean().default(true),

  // The composer's Enter writes a new line and Ctrl/⌘+Enter sends (Settings › General).
  enterNewline: z.boolean().default(false),

  // What goes to the Nyxs service with the user's account (Settings › Privacy). Read from the
  // user's own settings only (privacySettings.ts).
  privacy: z
    .object({
      chatTitles: z.boolean().default(true),
      imageDescriptions: z.boolean().default(true),
      semanticSearch: z.boolean().default(false),
      deviceDetails: z.boolean().default(true),
    })
    .default({ chatTitles: true, imageDescriptions: true, semanticSearch: false, deviceDetails: true }),

  permissions: permissionsSchema,

  hooks: hooksSchema,

  env: envSchema,

  outputStyle: z.string().optional(),

  // "onDemand" hides connector tools behind ToolSearch; "preloaded" sends every schema up front.
  toolAccessMode: z.enum(["onDemand", "preloaded"]).default("onDemand"),

  mcpServers: mcpServersSchema,

  enabledPlugins: enabledPluginsSchema,

  marketplaces: marketplacesSchema,

  cleanupPeriodDays: z.number().int().positive().default(DEFAULT_CLEANUP_PERIOD_DAYS),

  diagnostics: diagnosticsSchema,

  format: z
    .object({
      enabled: z.boolean().default(false),
      timeoutMs: z.number().int().positive().optional(),
      rules: z
        .array(z.object({ name: z.string().optional(), match: z.string(), detect: z.string().optional(), command: z.string() }))
        .optional(),
    })
    .optional(),

  rag: ragSchema,

  lsp: lspSchema,

  generation: generationSchema,

  workflow: workflowSchema,

  pullRequests: pullRequestsSchema,

  worktree: worktreeSchema,
} as const;

export const SettingsSchema = z.object(SETTINGS_FIELDS);

export type Settings = z.infer<typeof SettingsSchema>;

export type ToolAccessMode = Settings["toolAccessMode"];

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export interface ConfigError {

  file: string;

  path: string;

  message: string;
}
