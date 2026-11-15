import { getMergedSnapshot } from "@/lib/settingsRuntime";
import type { SearchChoice } from "@/lib/searchEngines";
import { desktopOs } from "@/lib/desktopOs";

/** The switches in Settings for what came from Claude Code Desktop, as they sit in settings.json,
 *  each with its default (all on: the behaviors work out of the box). */
export interface FeatureSettings {
  browser?: { followTheme?: boolean; reloadOnTheme?: boolean; searchEngine?: string; customSearchUrl?: string; customSuggestUrl?: string };
  chat?: { clickablePaths?: boolean; planLimitWarning?: boolean; splitView?: boolean };
  files?: { autoSave?: boolean };
  sessions?: { warnUncommittedArchive?: boolean };
  permissions?: { rememberModePerFolder?: boolean; defaultMode?: string; autoApproveReadOnly?: boolean };
}

const snap = () => getMergedSnapshot() as FeatureSettings;

/** Pages in the built-in browser see the app's light or dark theme. */
export const browserFollowsTheme = () => snap().browser?.followTheme ?? true;
/** A page that doesn't repaint for a theme change is reloaded (see preview_webview.rs). */
export const browserReloadsOnTheme = () => snap().browser?.reloadOnTheme ?? true;
/** Where the address bar sends a search (Google unless another engine is chosen). */
export const browserSearch = (): SearchChoice => ({
  engine: snap().browser?.searchEngine,
  customUrl: snap().browser?.customSearchUrl,
  customSuggestUrl: snap().browser?.customSuggestUrl,
});
/** File paths in the chat open on click and have a menu. */
export const clickablePaths = () => snap().chat?.clickablePaths ?? true;
/** The composer warns when a Claude Code plan limit nears or hits its cap. */
export const planLimitWarning = () => snap().chat?.planLimitWarning ?? true;
/** Two sessions can be open side by side (App reads `chat.splitView` reactively via useSettings). */
export const splitView = () => snap().chat?.splitView ?? true;
/** The Files panel saves edits on its own after a pause (Desktop's Auto save, on by default). */
export const autoSaveFiles = () => snap().files?.autoSave ?? true;
/** Archiving a session with uncommitted files asks first. */
export const warnUncommittedArchive = () => snap().sessions?.warnUncommittedArchive ?? true;
/** A new chat starts in the mode last used in its folder. */
export const rememberModePerFolder = () => snap().permissions?.rememberModePerFolder ?? true;
/** In "Accept edits", read-only shell commands (`isAutoApprovableReadOnly`) run without asking.
 *  Off, they ask like any other command. Any layer can turn it off: that only asks more. */
export const autoApproveReadOnly = () => snap().permissions?.autoApproveReadOnly ?? true;

/** The Computer tool (the agent drives the desktop). Off unless turned on; Windows and macOS
 *  (on macOS older than 14 the Rust side reports it unsupported and Settings keeps it off). */
/** The agent's Music tool, on unless `allowMusic` is set to false. */
export const musicToolEnabled = () => (getMergedSnapshot() as { allowMusic?: boolean }).allowMusic !== false;

export const computerUseEnabled = () =>
  (getMergedSnapshot() as { allowComputerUse?: boolean }).allowComputerUse === true &&
  desktopOs() !== "linux";
