/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The backend base URL for a native end-to-end test build (see src/lib/auth.ts). */
  readonly VITE_NYXS_API_BASE?: string;
  /** "1" in a dev build shows the update card with sample notes (src/components/UpdateAlert.tsx). */
  readonly VITE_DEV_UPDATE_CARD?: string;
}
