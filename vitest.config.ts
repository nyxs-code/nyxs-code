import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    // Component tests (*.test.tsx) ask for jsdom with a `@vitest-environment jsdom` comment.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
  },
});
