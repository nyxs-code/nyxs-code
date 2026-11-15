import { describe, expect, it } from "vitest";
import { isDevServerCommand } from "../helpers";

describe("isDevServerCommand", () => {
  it("knows the commands that start a server", () => {
    for (const cmd of [
      "npm run dev",
      "pnpm dev",
      "vite",
      "npx vite --port 5174",
      "vite preview",
      "next dev",
      "ng serve",
      "npx serve dist",
      "serve -s build",
      "python -m http.server 8000",
      "php -S localhost:8080",
      "npm run build && npx serve out",
    ]) {
      expect(isDevServerCommand(cmd), cmd).toBe(true);
    }
  });

  it("leaves out builds and commands that only mention serving", () => {
    for (const cmd of [
      "vite build --watch",
      "npx vite build",
      "vite optimize",
      "vitest",
      "cargo run --bin serve-docs",
      "git log --grep=serve",
      "echo serve",
      "npm run build",
    ]) {
      expect(isDevServerCommand(cmd), cmd).toBe(false);
    }
  });
});
