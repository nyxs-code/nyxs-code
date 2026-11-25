import { useEffect } from "react";
import { setAmbientPaused, startAmbient, stopAmbient } from "@/lib/ambientSound";
import { useAppearance } from "@/lib/appearance";

/** Plays the ambience chosen in Settings › Appearance › Theme sound while the window is on
 *  screen; quiet while it's hidden or minimized. Draws nothing. */
export function ThemeSound() {
  const { themeSound, themeSoundVolume } = useAppearance();

  useEffect(() => {
    if (themeSound === "off") {
      stopAmbient();
      return;
    }
    startAmbient(themeSound, themeSoundVolume);
  }, [themeSound, themeSoundVolume]);

  // Stops for good only when the app goes away (a reload, the window closing).
  useEffect(() => () => stopAmbient(), []);

  useEffect(() => {
    const onVisibility = () => setAmbientPaused(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return null;
}
