import { useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AppWindow, FolderOpen, Globe, Loader2, Music } from "lucide-react";
import { SpotifyLogo, YouTubeMusicLogo } from "@/components/music/musicLogos";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import { chooseFolder, connectYouTube, disconnectYouTube, formatTime, playTrack, restoreFolder, setSystemEnabled, signInToYouTube, systemMusicSupported, useMusic } from "@/lib/music/player";
import { cn } from "@/lib/utils";
import { SettingsToggle } from "./settingsControls";

/** The same tile as the providers' logos (ProviderIcon). */
const tile = "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[8px]";

/** Where the music services are connected; the player itself lives in the title bar. */
export function MusicSettingsSection() {
  const t = useTranslations().music;
  const music = useMusic();
  // Only known once its page has answered.
  const signedOut = music.youtubeConnected && music.youtube?.signedIn === false;

  useEffect(restoreFolder, [music.folder]);

  const pickFolder = async () => {
    const picked = await openDialog({ directory: true, title: t.chooseFolder, defaultPath: music.folder ?? undefined }).catch(() => null);
    if (typeof picked === "string") void chooseFolder(picked);
  };

  return (
    <div className="space-y-10">
      <section>
        <h3 className="text-sm font-semibold text-text-100 mb-2">{t.services}</h3>
        <div className="divide-y divide-bg-300 border-t border-bg-300">
          <div className="flex items-center gap-3 py-4">
            <span className={cn(tile, "bg-white")}>
              <YouTubeMusicLogo className="w-5 h-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-100">YouTube Music</p>
              <p className="flex items-center gap-1.5 text-[12px] text-text-400 mt-0.5">
                {music.youtubeConnected && !signedOut && <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />}
                {signedOut ? t.signInNeeded : music.youtubeConnected ? t.connected : t.youtubeMusicDesc}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {signedOut && <Button variant="primary" onClick={signInToYouTube}>{t.signIn}</Button>}
              {music.youtubeConnected ? (
                <Button onClick={disconnectYouTube}>{t.disconnect}</Button>
              ) : (
                <Button variant="primary" onClick={() => void connectYouTube()}>{t.connect}</Button>
              )}
            </div>
          </div>
          {systemMusicSupported() && (
            <div className="flex items-center gap-3 py-4">
              <span className={cn(tile, "bg-bg-200 text-text-300")}>
                <AppWindow className="w-[18px] h-[18px]" strokeWidth={1.8} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-text-100">
                  {t.otherApps}
                  <SpotifyLogo className="w-3.5 h-3.5 shrink-0" />
                  <Globe className="w-3.5 h-3.5 shrink-0 text-text-400" aria-hidden="true" />
                </p>
                <p className="text-[12px] text-text-400 mt-0.5">{t.otherAppsDesc}</p>
              </div>
              <SettingsToggle label={t.otherApps} checked={music.systemEnabled} onChange={setSystemEnabled} />
            </div>
          )}
        </div>
      </section>
      <section>
        <h3 className="text-sm font-semibold text-text-100 mb-2">{t.thisComputer}</h3>
        <div className="flex items-center gap-3 py-4 border-t border-bg-300">
          <span className={cn(tile, "bg-bg-200 text-text-300")}>
            <Music className="w-[18px] h-[18px]" strokeWidth={1.8} aria-hidden="true" />
          </span>
          <p className="min-w-0 flex-1 truncate text-[12px] text-text-400">{music.folder ?? t.folderHint}</p>
          <Button onClick={() => void pickFolder()}>
            <FolderOpen className="w-3.5 h-3.5" />
            {music.folder ? t.changeFolder : t.chooseFolder}
          </Button>
        </div>
        {music.scanning && (
          <p className="flex items-center gap-1.5 pb-2 text-[12px] text-text-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t.scanning}
          </p>
        )}
        {music.scanFailed && <p role="alert" className="pb-2 text-[12px] text-red-400">{t.scanFailed}</p>}
        {music.playFailed && <p role="alert" className="pb-2 text-[12px] text-red-400">{t.playFailed}</p>}
        {!music.scanning && !music.scanFailed && music.folder && music.tracks.length === 0 && <p className="pb-2 text-[12px] text-text-400">{t.noTracks}</p>}
        {music.truncated && <p className="pb-2 text-[12px] text-text-400">{t.truncated.replace("{count}", String(music.tracks.length))}</p>}
        <ul>
          {music.tracks.map((track, i) => (
            <li key={track.path}>
              <button
                type="button"
                onClick={() => void playTrack(i)}
                aria-current={i === music.index ? "true" : undefined}
                className={cn("flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-bg-200 transition-colors", i === music.index && "bg-bg-200")}
              >
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[13px]", i === music.index ? "font-medium text-text-100" : "text-text-200")}>{track.title}</span>
                  {track.artist && <span className="block truncate text-[12px] text-text-400">{track.artist}</span>}
                </span>
                {track.duration > 0 && <span className="shrink-0 text-[12px] tabular-nums text-text-500">{formatTime(track.duration)}</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
