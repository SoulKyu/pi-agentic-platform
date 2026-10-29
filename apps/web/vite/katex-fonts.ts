import type { Plugin } from "vite";

const KATEX_CSS = /[\\/]katex[\\/]dist[\\/]katex\.min\.css$/u;
/** The `woff` and `truetype` fallbacks of a `@font-face` source list; the woff2 entry before them stays. */
const OLD_FORMATS = /,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/gu;

/** KaTeX's stylesheet down to its woff2 files; the browsers pap targets all read woff2. */
export function woff2Only(css: string): string {
  return css.replace(OLD_FORMATS, "");
}

/**
 * KaTeX lists each font three times (woff2, woff, truetype), and the service worker precaches every file of the build:
 * three formats would triple the install download for files no supported browser asks for. Only the woff2 files ship
 * (UX2-R47: still files, never inlined).
 */
export function katexFonts(): Plugin {
  return {
    name: "pap-katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      const path = id.split("?")[0] ?? id;
      return KATEX_CSS.test(path) ? { code: woff2Only(code), map: null } : null;
    },
  };
}
