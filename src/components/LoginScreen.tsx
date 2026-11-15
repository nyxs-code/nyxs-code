import { useState, useRef } from "react";
import { TitleBar } from "./TitleBar";
import { signInWithGoogle, type AuthUser } from "@/lib/auth";
import { localizedError, useTranslations } from "@/lib/i18n";
import { BackendError } from "@/lib/ipc";

function GoogleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export function LoginScreen({ onSignedIn }: { onSignedIn: (user: AuthUser) => void }) {
  const t = useTranslations().login;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef(0);

  const signIn = async () => {
    const attempt = ++attemptRef.current;
    setBusy(true);
    setError(null);
    try {
      const user = await signInWithGoogle();
      if (attempt !== attemptRef.current) return;
      onSignedIn(user);
    } catch (e) {
      if (attempt !== attemptRef.current) return;
      setError((e instanceof BackendError ? localizedError(e) : (e as Error).message) || t.signInError);
    } finally {
      if (attempt === attemptRef.current) setBusy(false);
    }
  };

  const cancel = () => {
    attemptRef.current++;
    setBusy(false);
    setError(null);
  };

  return (
    <div className="flex flex-col h-full w-full bg-bg-0 text-text-100">
      <TitleBar minimal />
      <div data-tauri-drag-region className="flex-1 flex flex-col items-center justify-center select-none">
        <div className="flex flex-col items-center gap-6 px-8 max-w-sm text-center">
          <img src="/logo.png" alt="Nyxs" className="w-16 h-16" draggable={false} />
          <div>
            <h1 className="text-2xl font-serif font-light text-text-100">Nyxs</h1>
            <p className="mt-1 text-sm text-text-400">{t.subtitle}</p>
          </div>
          <button
            onClick={signIn}
            disabled={busy}
            className="flex items-center justify-center gap-3 w-full rounded-[8px] border border-bg-300 bg-bg-100 px-4 py-2.5 text-sm font-medium text-text-100 hover:bg-bg-200 disabled:opacity-60 transition-colors"
          >
            <GoogleIcon />
            {busy ? t.openingBrowser : t.continueWithGoogle}
          </button>
          {busy && (
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs text-text-400">
                {t.browserHint}
              </p>
              <button
                onClick={cancel}
                className="text-xs text-text-400 hover:text-text-200 underline-offset-2 hover:underline transition-colors"
              >
                {t.cancel}
              </button>
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}

export default LoginScreen;
