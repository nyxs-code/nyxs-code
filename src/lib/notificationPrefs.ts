import { loadGlobalConfig, type GeneralPreferences } from "@/lib/globalConfig";
import { DEFAULT_NOTIFICATION_SOUND, isNotificationSoundId, type NotificationSoundId } from "@/lib/notificationSounds";

export type NotificationKind = keyof NonNullable<GeneralPreferences["notifications"]>;

export const NOTIFICATION_DEFAULTS: Record<NotificationKind, boolean> = {
  responseCompletions: true,
  codeUpdates: true,
  codePermissionRequests: true,
  otherSessions: true,
};

let cached: Partial<Record<NotificationKind, boolean>> | null = null;
let cachedSound: NotificationSoundId = DEFAULT_NOTIFICATION_SOUND;

export function isNotificationEnabled(kind: NotificationKind): boolean {
  if (cached && kind in cached) return cached[kind] === true;
  return NOTIFICATION_DEFAULTS[kind];
}

/** The sound chosen in Settings. */
export function getNotificationSound(): NotificationSoundId {
  return cachedSound;
}

/** An unknown saved value (a sound since removed, a hand edit) falls back to the default. */
export function resolveNotificationSound(saved: unknown): NotificationSoundId {
  return isNotificationSoundId(saved) ? saved : DEFAULT_NOTIFICATION_SOUND;
}

export async function refreshNotificationPrefs(): Promise<void> {
  const cfg = await loadGlobalConfig();
  cached = cfg.general?.notifications ?? null;
  cachedSound = resolveNotificationSound(cfg.general?.notificationSound);
}
