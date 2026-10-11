import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const SOURCE = new URL("../src/features/appearance/boot-script.js", import.meta.url);
const DEV_PATH = "/@pap/appearance-boot.js";

/**
 * Ships the appearance boot script as a hashed classic script linked first in <head> (DESIGN.md §14, R74). The tag is
 * added after Vite's own HTML processing (no `order: "pre"`), so Vite never tries to bundle a non-module script.
 */
export function appearanceBoot(): Plugin {
  const source = readFileSync(SOURCE, "utf8");
  const fileName = `assets/appearance-boot-${createHash("sha256").update(source).digest("hex").slice(0, 10)}.js`;
  let command = "build";
  return {
    name: "pap-appearance-boot",
    configResolved(config) {
      command = config.command;
    },
    configureServer(server) {
      server.middlewares.use(DEV_PATH, (_request, response) => {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        response.end(source);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName, source });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { src: command === "serve" ? DEV_PATH : `/${fileName}` },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}
