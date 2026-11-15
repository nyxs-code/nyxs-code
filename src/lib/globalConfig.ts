import { globalConfigFile } from "@/lib/paths";
import { readJsonFile, UnreadableFileError, writeJsonFile } from "@/lib/safeJsonFile";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ProjectConfig {
  trusted?: boolean;
  trustedSettingsHash?: string;
  onboardingSeenCount?: number;
  lastSessionId?: string;
  mcpToggles?: Record<string, boolean>;
  /** The answer to "Index this project on the Nyxs service?" (semantic search); none yet when
   *  not asked. */
  ragConsent?: "granted" | "declined";
  [key: string]: unknown;
}

export interface GeneralPreferences {
  fullName?: string;
  displayName?: string;
  workRole?: string;
  customInstructions?: string;
  chatFont?: string;
  notifications?: Partial<{
    responseCompletions: boolean;
    codeUpdates: boolean;
    codePermissionRequests: boolean;
    /** Also notify for a session you aren't looking at while Nyxs is in front. */
    otherSessions: boolean;
  }>;
  /** A `NotificationSoundId`; "none" keeps notifications silent. */
  notificationSound?: string;
  privacy?: Partial<{
    telemetry: boolean;
    crashReports: boolean;
  }>;
}

export interface GlobalConfig {
  version: 1;
  projects: Record<string, ProjectConfig>;
  general?: GeneralPreferences;
  numStartups?: number;
  lastSeenChangelogVersion?: string;
  theme?: string;
  [key: string]: unknown;
}

export const ONBOARDING_MAX_SHOWS = 3;

function emptyConfig(): GlobalConfig {
  return { version: 1, projects: {} };
}

async function configPath(): Promise<string> {
  return globalConfigFile();
}

let cache: GlobalConfig | null = null;
let loading: Promise<GlobalConfig> | null = null;

async function readFromDisk(): Promise<GlobalConfig> {
  if (!isTauri) return emptyConfig();
  const read = await readJsonFile<Partial<GlobalConfig>>(await configPath(), { backup: true });
  if (read.status !== "ok" || !read.value || typeof read.value !== "object") return emptyConfig();
  return {
    version: 1,
    projects: read.value.projects ?? {},
    ...read.value,
  };
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  if (cache) return cache;
  if (!loading) {
    loading = readFromDisk().then((cfg) => {
      cache = cfg;
      loading = null;
      return cfg;
    });
  }
  return loading;
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  cache = config;
  if (!isTauri) return;
  try {
    await writeJsonFile(await configPath(), config, { noticeOnce: true });
  } catch (e) {
    // An unreadable nyxs.json keeps its content: this run goes on from memory, unsaved.
    if (e instanceof UnreadableFileError) return;
    throw e;
  }
}

export async function updateGlobalConfig(
  partial: Partial<Omit<GlobalConfig, "version" | "projects">>,
): Promise<GlobalConfig> {
  const cfg = await loadGlobalConfig();
  const next: GlobalConfig = { ...cfg, ...partial };
  await saveGlobalConfig(next);
  return next;
}

export async function updateGeneralPreferences(
  partial: Partial<GeneralPreferences>,
): Promise<GeneralPreferences> {
  const cfg = await loadGlobalConfig();
  const prev = cfg.general ?? {};
  const next: GeneralPreferences = {
    ...prev,
    ...partial,
    notifications: partial.notifications
      ? { ...prev.notifications, ...partial.notifications }
      : prev.notifications,
    privacy: partial.privacy
      ? { ...prev.privacy, ...partial.privacy }
      : prev.privacy,
  };
  await saveGlobalConfig({ ...cfg, general: next });
  if (partial.notifications || "notificationSound" in partial) {
    const { refreshNotificationPrefs } = await import("@/lib/notificationPrefs");
    await refreshNotificationPrefs();
  }
  return next;
}

export function resetGlobalConfigCache(): void {
  cache = null;
  loading = null;
}

export async function getProjectConfig(path: string): Promise<ProjectConfig> {
  const cfg = await loadGlobalConfig();
  return cfg.projects[path] ?? {};
}

export async function updateProjectConfig(
  path: string,
  partial: Partial<ProjectConfig>,
): Promise<ProjectConfig> {
  const cfg = await loadGlobalConfig();
  const next: ProjectConfig = { ...(cfg.projects[path] ?? {}), ...partial };
  await saveGlobalConfig({
    ...cfg,
    projects: { ...cfg.projects, [path]: next },
  });
  return next;
}

export async function isWorkspaceTrusted(path: string): Promise<boolean> {
  return (await getProjectConfig(path)).trusted === true;
}

export async function trustWorkspace(path: string, settingsDigest?: string): Promise<void> {
  await updateProjectConfig(path, {
    trusted: true,
    ...(settingsDigest !== undefined ? { trustedSettingsHash: settingsDigest } : {}),
  });
}

export async function getOnboardingSeenCount(path: string): Promise<number> {
  return (await getProjectConfig(path)).onboardingSeenCount ?? 0;
}

export async function markOnboardingSeen(path: string): Promise<void> {
  const count = await getOnboardingSeenCount(path);
  await updateProjectConfig(path, { onboardingSeenCount: count + 1 });
}

export async function dismissOnboarding(path: string): Promise<void> {
  await updateProjectConfig(path, { onboardingSeenCount: ONBOARDING_MAX_SHOWS });
}

export async function setLastSessionId(
  workspacePath: string,
  sessionId: string,
): Promise<void> {
  await updateProjectConfig(workspacePath, { lastSessionId: sessionId });
}

export async function getRagConsent(workspacePath: string): Promise<ProjectConfig["ragConsent"]> {
  return (await getProjectConfig(workspacePath)).ragConsent;
}

export async function setRagConsent(workspacePath: string, consent: "granted" | "declined"): Promise<void> {
  await updateProjectConfig(workspacePath, { ragConsent: consent });
}

export async function bumpStartupCount(): Promise<number> {
  const cfg = await loadGlobalConfig();
  const next = (cfg.numStartups ?? 0) + 1;
  await updateGlobalConfig({ numStartups: next });
  return next;
}

export async function markChangelogSeen(version: string): Promise<void> {
  await updateGlobalConfig({ lastSeenChangelogVersion: version });
}
