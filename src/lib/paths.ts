import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";
import { getCurrentUserId } from "./auth";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function accountSeg(): string {
  const uid = getCurrentUserId();
  return uid ? join("accounts", uid) : "";
}

let cachedHome: string | null = null;

export async function resolveHome(): Promise<string> {
  if (cachedHome != null) return cachedHome;
  const override = (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__NYXS_HOME__) as string | undefined;
  if (override) {
    cachedHome = norm(override);
    return cachedHome;
  }
  if (!isTauri) {
    cachedHome = "~";
    return cachedHome;
  }
  const home = await tauriHomeDir();
  cachedHome = norm(home);
  return cachedHome;
}

function norm(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

function join(...parts: string[]): string {
  return parts.map(norm).filter(Boolean).join("/");
}

export async function userNyxsDir(): Promise<string> {
  return join(await resolveHome(), ".nyxs");
}

export async function userAttachmentsDir(): Promise<string> {
  return join(await userNyxsDir(), "attachments");
}

export async function userSettingsFile(): Promise<string> {
  return join(await userNyxsDir(), "settings.json");
}

export async function globalConfigFile(): Promise<string> {
  return join(await userNyxsDir(), accountSeg(), "nyxs.json");
}

export async function userSkillsDir(): Promise<string> {
  return join(await userNyxsDir(), "skills");
}

export async function userForeignSkillsDirs(): Promise<string[]> {
  const home = await resolveHome();
  return [join(home, ".claude", "skills")];
}

export async function userCommandsDir(): Promise<string> {
  return join(await userNyxsDir(), "commands");
}

export function projectNyxsDir(workspace: string): string {
  return join(workspace, ".nyxs");
}

export function projectSettingsFile(workspace: string): string {
  return join(projectNyxsDir(workspace), "settings.json");
}

export function projectLocalSettingsFile(workspace: string): string {
  return join(projectNyxsDir(workspace), "settings.local.json");
}

export function projectSkillsDir(workspace: string): string {
  return join(projectNyxsDir(workspace), "skills");
}

export function projectCommandsDir(workspace: string): string {
  return join(projectNyxsDir(workspace), "commands");
}
