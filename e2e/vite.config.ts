import { defineConfig, mergeConfig, type Plugin } from "vite";
import path from "node:path";
import base from "../vite.config";

// The app as `npm run dev` serves it, plus a fake Tauri backend (bootstrap.ts) loaded before
// src/main.tsx. Own port and dep cache, so it never collides with a running `tauri dev`.
const PORT = Number(process.env.NYXS_E2E_PORT ?? 1431);

function injectBootstrap(): Plugin {
  return {
    name: "nyxs-e2e-bootstrap",
    transformIndexHtml(html) {
      // Module scripts run in document order, so the mocks exist before any app module reads
      // `window.__TAURI_INTERNALS__`.
      return html.replace(
        /<script type="module"/,
        '<script type="module" src="/e2e/bootstrap.ts"></script>\n    <script type="module"',
      );
    },
  };
}

export default mergeConfig(
  base,
  defineConfig({
    root: path.resolve(__dirname, ".."),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-e2e"),
    plugins: [injectBootstrap()],
    resolve: {
      alias: {
        // Model and auth requests go through the page's own fetch, where Playwright routes them.
        "@tauri-apps/plugin-http": path.resolve(__dirname, "shims/plugin-http.ts"),
      },
    },
    server: { port: PORT, strictPort: true, hmr: false },
    // Crawl every source file when the server starts, so all dependencies are pre-bundled up
    // front. Otherwise one imported only once signed in (or by a lazy screen) is found while the
    // first tests load, Vite re-optimizes and reloads their pages, and they time out. Unit tests
    // stay out: some import the video runtime's scripts, whose dependencies only exist once the
    // runtime is installed, and one unresolved import makes the scan give up on pre-bundling.
    optimizeDeps: { entries: ["index.html", "src/**/*.{ts,tsx}", "!src/**/__tests__/**", "e2e/bootstrap.ts", "dev/update-card.html"] },
  }),
);
