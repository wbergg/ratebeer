import { defineConfig } from "vitest/config";

// Pure-logic tests; kept separate from vite.config.ts so the Cloudflare plugin isn't loaded.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
