import { useEffect, useState, type ReactNode } from "react";
import { getSession, type AuthUser } from "@/lib/auth";
import { reportDevice } from "@/lib/telemetry";
import { LoginScreen } from "./LoginScreen";

type AuthState =
  | { status: "checking" }
  | { status: "out" }
  | { status: "in"; user: AuthUser };

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "checking" });

  useEffect(() => {
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
