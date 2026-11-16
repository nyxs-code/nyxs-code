import { useEffect, useState, type ReactNode } from "react";
import { getSession, type AuthUser } from "@/lib/auth";
import { reportDevice } from "@/lib/telemetry";
import { LoginScreen } from "./LoginScreen";

type AuthState =
  | { status: "checking" }
  | { status: "out" }
  | { status: "in"; user: AuthUser };

/** The dev server opened in a browser tab (Chrome, or Nyxs' own browser, whose tabs get Tauri's
 *  bridge but none of the app's commands) can't sign in: the sign-in needs the backend. There
 *  the UI shows without an account. Never in a build: `DEV` is false and this code is dropped. */
function devBrowserTab(): boolean {
  if (!import.meta.env.DEV) return false;
  const internals = (window as { __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: string } } } }).__TAURI_INTERNALS__;
  if (!internals) return true;
  const label = internals.metadata?.currentWebview?.label;
  return label !== "main" && label !== "quick";
}

const DEV_USER: AuthUser = { id: 0, email: "dev@localhost", name: "Dev" };

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => (devBrowserTab() ? { status: "in", user: DEV_USER } : { status: "checking" }));

  useEffect(() => {
    if (devBrowserTab()) return;
    let alive = true;
    getSession().then((user) => {
      if (!alive) return;
      setState(user ? { status: "in", user } : { status: "out" });
      if (user) void reportDevice();
    });
    return () => {
      alive = false;
    };
  }, []);

  if (state.status === "checking") return null;
  if (state.status === "out") {
    return <LoginScreen onSignedIn={() => window.location.reload()} />;
  }
  return <>{children}</>;
}

export default AuthGate;
