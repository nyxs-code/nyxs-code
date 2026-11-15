import { useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";

let browserNamePromise: Promise<string | null> | null = null;

/** The system's default browser, for "Open in …" (null when it can't be told). */
export function useDefaultBrowserName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    browserNamePromise ??= invoke<string | null>("default_browser_name").catch(() => null);
    let alive = true;
    void browserNamePromise.then((n) => { if (alive) setName(n); });
    return () => { alive = false; };
  }, []);
  return name;
}
