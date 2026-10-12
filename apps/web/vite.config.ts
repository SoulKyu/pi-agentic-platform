import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { BROWSER_TARGETS } from "./browser-targets.ts";
import { appearanceBoot } from "./vite/appearance-boot.ts";

const daemon = process.env.PAP_DEV_DAEMON ?? "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [appearanceBoot(), react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  resolve: {
    alias: [{ find: /^zod$/, replacement: fileURLToPath(new URL("./src/csp-safe-zod.ts", import.meta.url)) }],
  },
  build: {
    target: BROWSER_TARGETS,
    outDir: "dist",
    sourcemap: false,
    // The daemon's CSP is `font-src 'self'` (no data:). Vite inlines assets under 4 KiB as data: URIs by
    // default; a font always stays a file (R118). Everything else keeps the default size limit.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
    // One shared chunk for the modules already in the initial closure: without it Rolldown cuts them into several
    // small chunks as soon as a lazy chunk reuses them (about 3 KB gzip of glue). Lazy-only modules are untouched.
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: "shared", tags: ["$initial"], test: /node_modules|packages\// }] },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/auth": daemon,
      "/healthz": daemon,
      "/ws": { target: daemon.replace(/^http/, "ws"), ws: true },
    },
  },
});
