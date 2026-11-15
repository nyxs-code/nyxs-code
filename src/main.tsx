import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/index.css";
import "./index.css";
import App from "./App";
import { AuthGate } from "./components/AuthGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { invoke } from "@/lib/ipc";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { QuickWindow } from "./components/QuickWindow";
import { initTheme, restorePersistedTheme } from "./lib/theme";
import { installFrontendLogging } from "./lib/logs";
import { splashGone } from "./lib/splash";
import { initAppearance } from "./lib/appearance";
import { installMacKeyGuard } from "./lib/macKeyGuard";
import { hydrateProviderKeys } from "./lib/settings";
import { getCurrentUserId } from "./lib/auth";
import { adoptLegacyAccountData } from "./lib/accountScope";
import { runMigrations } from "./lib/migrations";
import { refreshNotificationPrefs } from "./lib/notificationPrefs";
import { config as configureZod } from "zod";
import { runHeadless, type HeadlessArgs } from "./headless";

configureZod({ jitless: true });
installFrontendLogging();
initTheme();
initAppearance();
if (/Mac/i.test(navigator.platform || navigator.userAgent)) installMacKeyGuard();

const isQuickWindow = "__TAURI_INTERNALS__" in window && getCurrentWindow().label === "quick";

function mount(): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <AuthGate>
          <App />
        </AuthGate>
      </ErrorBoundary>
    </StrictMode>,
  );
}

(async () => {
  if (isQuickWindow) {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <QuickWindow />
      </StrictMode>,
    );
    return;
  }
  try {
    await runMigrations();
  } catch (err) {
    console.error("Las migraciones de configuración fallaron", err);
  }
  try {
    await hydrateProviderKeys();
  } catch (err) {
    console.error("No se pudieron cargar las API keys del keychain", err);
  }
  try {
    await invoke("nyxs_set_account", { account: getCurrentUserId() });
    await adoptLegacyAccountData();
    restorePersistedTheme();
  } catch (err) {
    console.error("No se pudo inicializar el aislamiento por cuenta", err);
  }
  try {
    await refreshNotificationPrefs();
  } catch (err) {
    console.error("No se pudieron cargar las preferencias de notificación", err);
  }
  const headless = await invoke<HeadlessArgs | null>("nyxs_headless_args").catch(() => null);
  if (headless) {
    await runHeadless(headless);
    return;
  }
  mount();
})();

const SPLASH_MIN_MS = 1900;
const splash = document.getElementById("nyxs-splash");
if (splash) {
  window.setTimeout(() => {
    splash.classList.add("nyxs-hide");
    // The browser's websites, drawn over everything, show once it has faded out (splash.ts).
    let gone = false;
    const remove = () => {
      if (gone) return;
      gone = true;
      splash.remove();
      splashGone();
    };
    splash.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 700);
  }, SPLASH_MIN_MS);
}
