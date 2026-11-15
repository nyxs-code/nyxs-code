import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";

const host = process.env.TAURI_DEV_HOST;

type CspMap = Record<string, string | string[]>;

function devContentSecurityPolicy(port: number): string | undefined {
  const conf = JSON.parse(fs.readFileSync(path.resolve(__dirname, "src-tauri/tauri.conf.json"), "utf8"));
  const csp: string | CspMap | null | undefined = conf.app?.security?.devCsp ?? conf.app?.security?.csp;
  if (!csp) return undefined;
  if (typeof csp === "string") return csp;
  const directives: Record<string, string[]> = {};
  for (const [name, sources] of Object.entries(csp)) {
    directives[name] = Array.isArray(sources) ? [...sources] : sources.split(/\s+/).filter(Boolean);
  }
  const connect = (directives["connect-src"] ??= ["'self'"]);
  for (const origin of [`ws://localhost:${port}`, `ws://127.0.0.1:${port}`]) {
    if (!connect.includes(origin)) connect.push(origin);
  }
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

function devCspPlugin(): Plugin {
  return {
    name: "nyxs-dev-csp",
    apply: "serve",
    configureServer(server) {
      // Read on every request, not once at start-up: a dev server left running kept serving the
      // old policy after tauri.conf.json changed (it blocked the video player's iframe).
      server.middlewares.use((_req, res, next) => {
        const csp = devContentSecurityPolicy(server.config.server.port ?? 1420);
        if (csp) res.setHeader("Content-Security-Policy", csp);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devCspPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/node_modules/**",
        "**/plugins/marketplaces/**",
        "**/plugins/cache/**",
        "**/.git/**",
      ],
    },
  },
});
