import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __CANDIDATE__: JSON.stringify(mode.startsWith("pierre") ? "pierre" : mode === "baseline" ? "none" : "codemirror"),
    __SYNTAX__: JSON.stringify(mode === "codemirror-syntax"),
    __WORKER__: JSON.stringify(mode === "pierre-worker"),
  },
  build: { target: ["safari16.4", "chrome111", "firefox111"], outDir: `dist-${mode}` },
}));
