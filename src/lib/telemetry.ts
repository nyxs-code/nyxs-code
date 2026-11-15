import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@/lib/ipc";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AUTH_BASE, getToken } from "./auth";
import { privacySettings } from "./privacySettings";

let cachedVersion: string | null = null;
async function appVersion(): Promise<string | undefined> {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = await getVersion();
    return cachedVersion;
  } catch {
    return undefined;
  }
}

const http = tauriFetch as unknown as typeof fetch;

export async function reportUsage(model: string, inputTokens: number, outputTokens: number): Promise<void> {
  const token = await getToken();
  if (!token) return;
  try {
    await http(`${AUTH_BASE}/api/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, inputTokens, outputTokens, appVersion: await appVersion() }),
    });
  } catch {
    /* ignore */
  }
}

interface DeviceInfo {
  platform?: string;
  os?: string;
  os_version?: string;
  os_build?: string;
  arch?: string;
  hwid?: string;
  cpu?: string;
  cpu_cores?: string;
  total_memory?: string;
  hostname?: string;
}

let deviceReported = false;
export async function reportDevice(): Promise<void> {
  if (deviceReported) return;
  const token = await getToken();
  if (!token) return;
  try {
    const info = await invoke<DeviceInfo>("device_info");
    // Off in Settings › Privacy: only the operating system goes.
    const device: DeviceInfo = (await privacySettings()).deviceDetails ? info : { platform: info.platform, os: info.os };
    await http(`${AUTH_BASE}/api/version`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ appVersion: await appVersion(), device }),
    });
    deviceReported = true;
  } catch {
    /* ignore — telemetry must not affect the UX */
  }
}

export async function sendFeedback(message: string, rating: number, screenshot?: string): Promise<void> {
  const token = await getToken();
  if (!token) throw new Error("Inicia sesión para enviar comentarios.");
  const res = await http(`${AUTH_BASE}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, rating, screenshot, appVersion: await appVersion() }),
  });
  if (!res.ok) throw new Error("No se pudo enviar el comentario. Inténtalo de nuevo.");
}

export interface Announcement {
  id: number;
  title: string;
  body: string;
  level: string;
  created_at: string;
}

export async function fetchAnnouncements(): Promise<Announcement[]> {
  const token = await getToken();
  if (!token) return [];
  try {
    const res = await http(`${AUTH_BASE}/api/announcements`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    return (await res.json()) as Announcement[];
  } catch {
    return [];
  }
}
