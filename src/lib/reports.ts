import { getVersion } from "@tauri-apps/api/app";
import { loadMergedMcpServers, mcpServerTarget } from "./mcp";
import { loadSkills } from "./skills";
import { getMergedSnapshot } from "./settingsRuntime";

export function toJsonBlock(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

async function appVersionSafe(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "unknown";
  }
}

export interface StatusInput {
  model: string;
  workspace: string | null;
  permissionMode: string;
  contextTokens?: number;
  messageCount?: number;
}

export interface StatusReport {
  schema: "nyxs.status/v1";
  appVersion: string;
  model: string;
  workspace: string | null;
  permissionMode: string;
  planMode: boolean;
  contextTokens: number;
  messages: number;
}

export async function buildStatusReport(i: StatusInput): Promise<StatusReport> {
  return {
    schema: "nyxs.status/v1",
    appVersion: await appVersionSafe(),
    model: i.model,
    workspace: i.workspace,
    permissionMode: i.permissionMode,
    planMode: i.permissionMode === "plan",
    contextTokens: i.contextTokens ?? 0,
    messages: i.messageCount ?? 0,
  };
}

export function formatStatusText(r: StatusReport): string {
  return [
    "**Status**",
    "",
    `- Model: \`${r.model}\``,
    `- Workspace: ${r.workspace ? `\`${r.workspace}\`` : "_none_"}`,
    `- Permission mode: ${r.permissionMode}${r.planMode ? " (plan)" : ""}`,
    `- Context tokens: ${r.contextTokens.toLocaleString("en-US")}`,
    `- Messages: ${r.messages}`,
    `- App version: ${r.appVersion}`,
  ].join("\n");
}

export interface McpReport {
  schema: "nyxs.mcp/v1";
  count: number;
  servers: { name: string; url: string; enabled: boolean }[];
}

export function buildMcpReport(): McpReport {
  const servers = loadMergedMcpServers().map((s) => ({
    name: s.name,
    url: mcpServerTarget(s),
    enabled: s.enabled,
  }));
  return { schema: "nyxs.mcp/v1", count: servers.length, servers };
}

export function formatMcpText(r: McpReport): string {
  if (r.count === 0) return "**MCP servers**\n\n_No MCP servers configured._";
  const lines = ["**MCP servers**", ""];
  for (const s of r.servers) {
    lines.push(`- ${s.enabled ? "🟢" : "⚪"} \`${s.name}\` — ${s.url}${s.enabled ? "" : " (disabled)"}`);
  }
  return lines.join("\n");
}

export interface SkillsReport {
  schema: "nyxs.skills/v1";
  count: number;
  skills: { name: string; source: string; description: string; whenToUse?: string }[];
}

export async function buildSkillsReport(workspace: string | null): Promise<SkillsReport> {
  const defs = await loadSkills(workspace);
  const skills = defs.map((s) => ({
    name: s.name,
    source: s.source,
    description: s.description,
    ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}),
  }));
  return { schema: "nyxs.skills/v1", count: skills.length, skills };
}

export function formatSkillsText(r: SkillsReport): string {
  if (r.count === 0) return "**Skills**\n\n_No skills available._";
  const lines = ["**Skills**", ""];
  for (const s of r.skills) {
    lines.push(`- \`/${s.name}\` _(${s.source})_ — ${s.description}`);
  }
  return lines.join("\n");
}

export interface DoctorInput {
  model: string;
  workspace: string | null;
}

export interface DoctorReport {
  schema: "nyxs.doctor/v1";
  app: { version: string };
  workspace: string | null;
  model: string;
  defaultPermissionMode: string;
  permissions: { allow: number; deny: number; ask: number };
  diagnostics: { enabled: boolean };
  lsp: { enabled: boolean };
  mcpServers: { name: string; url: string; enabled: boolean }[];
}

export async function buildDoctorReport(i: DoctorInput): Promise<DoctorReport> {
  const s = getMergedSnapshot() as {
    permissions?: { allow?: unknown[]; deny?: unknown[]; ask?: unknown[] };
    diagnostics?: { enabled?: boolean };
    lsp?: { enabled?: boolean };
    defaultPermissionMode?: string;
  };
  const perms = s.permissions ?? {};
  const mcpServers = loadMergedMcpServers().map((m) => ({
    name: m.name,
    url: mcpServerTarget(m),
    enabled: m.enabled,
  }));
  return {
    schema: "nyxs.doctor/v1",
    app: { version: await appVersionSafe() },
    workspace: i.workspace,
    model: i.model,
    defaultPermissionMode: s.defaultPermissionMode ?? "ask",
    permissions: {
      allow: perms.allow?.length ?? 0,
      deny: perms.deny?.length ?? 0,
      ask: perms.ask?.length ?? 0,
    },
    diagnostics: { enabled: s.diagnostics?.enabled ?? false },
    lsp: { enabled: s.lsp?.enabled ?? false },
    mcpServers,
  };
}
