// Fake Tauri backend for the E2E tests. Loaded before src/main.tsx (see e2e/vite.config.ts).
// Every `invoke` lands in `handle`; commands it does not know resolve to null and are recorded
// in `window.__E2E__.unknown`, so a test can spot a flow that needs a new stub.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createBackend, type E2EState } from "./backend";

declare global {
  interface Window {
    __E2E__: E2EState;
    /** Set by the test (addInitScript) before the page loads. */
    __E2E_SEED__?: Partial<E2EState["seed"]>;
  }
}

const backend = createBackend(window.__E2E_SEED__ ?? {});
window.__E2E__ = backend.state;

mockWindows("main");
mockIPC((cmd, args) => backend.handle(cmd, (args ?? {}) as Record<string, unknown>), {
  shouldMockEvents: true,
});

// Local files shown in the built-in browser go through Tauri's asset protocol, which the mocks
// leave out. Same form as Tauri's on Windows; nothing answers it, so the page stays blank.
(window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__.convertFileSrc = (
  path: string,
  protocol = "asset",
) => `http://${protocol}.localhost/${encodeURIComponent(path)}`;
