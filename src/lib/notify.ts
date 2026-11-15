import { invoke } from "@/lib/ipc";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import {
  getNotificationSound,
  isNotificationEnabled,
  type NotificationKind,
} from "@/lib/notificationPrefs";
import { playNotificationSound } from "@/lib/notificationSounds";
import { getAppearance } from "@/lib/appearance";
import { getLanguage, getTranslations } from "@/lib/i18n";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function requestWindowAttention(): Promise<void> {
  if (!isTauri || !getAppearance().requestAttention) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    await getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
  } catch {
    // Best-effort: not all platforms/window managers support it.
  }
}

async function systemNotify(title: string, body: string, chatId?: string): Promise<void> {
  if (!isTauri) return;
  try {
    const handled = await invoke<boolean>("nyxs_notify", { title, body, chatId: chatId ?? null }).catch(() => false);
    if (handled) return;
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // Notifications are best-effort.
  }
}

/** The session on screen and the sessions' titles, given by the app. */
let activeChatId: string | null = null;
let titleOf: (chatId: string) => string | undefined = () => undefined;

export function setNotifyContext(active: string | null, lookup: (chatId: string) => string | undefined): void {
  activeChatId = active;
  titleOf = lookup;
}

/** Whether the user is looking at this session: the window is in front and shows it. */
function lookingAt(chatId: string | undefined): boolean {
  if (typeof document === "undefined" || document.hidden || !document.hasFocus()) return false;
  // Settings can keep notifications to when Nyxs is in the background, as it used to be.
  if (!isNotificationEnabled("otherSessions")) return true;
  return !chatId || chatId === activeChatId;
}

const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);

/** Like Claude Code Desktop: a session that finishes or needs you while you aren't looking at it
 *  (the window in the background, or another session on screen) sends a system notification
 *  titled with its name. One you're looking at only chimes. */
async function alertUser(kind: NotificationKind, body: string, chatId?: string): Promise<void> {
  if (!isNotificationEnabled(kind)) return;
  playNotificationSound(getNotificationSound());
  if (lookingAt(chatId)) return;
  if (typeof document !== "undefined" && !document.hasFocus()) await requestWindowAttention();
  const title = (chatId && titleOf(chatId)?.trim()) || "Nyxs";
  await systemNotify(title, clip(body), chatId);
}

const tr = () => getTranslations(getLanguage()).notify;

export async function notifyTurnDone(chatId?: string): Promise<void> {
  await alertUser("responseCompletions", tr().taskFinished, chatId);
}

export async function notifyTurnError(body: string, chatId?: string): Promise<void> {
  await alertUser("codeUpdates", body, chatId);
}

export async function notifyQuestion(question: string, chatId?: string): Promise<void> {
  await alertUser("codePermissionRequests", question.trim() || tr().question, chatId);
}

export async function notifyPermissionRequest(label: string, chatId?: string): Promise<void> {
  await alertUser("codePermissionRequests", tr().permission.replace("{action}", label), chatId);
}
