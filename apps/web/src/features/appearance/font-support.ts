// One lazy chunk for everything that only a downloaded font needs: the installed list and the stylesheet links.
// The controller imports it the first time a custom font is chosen; nobody else pays for it in the initial bundle.
export { syncFontLinks } from "./font-links.ts";
export { loadFonts, useFontsStore } from "./fonts-store.ts";
