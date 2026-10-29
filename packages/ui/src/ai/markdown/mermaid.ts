import mermaid from "mermaid";
import { MAX_DIAGRAM_CHARS } from "./diagram-size.ts";

/**
 * Mermaid's own six defaults, and then every key a diagram's `%%{init: …}%%` could use to paint outside its box or to
 * bring HTML back (UX2-R83, decision 139): `themeCSS` goes into the SVG's `<style>`, HTML labels keep forms and buttons,
 * `dompurifyConfig` loosens the sanitiser. A `secure` list replaces Mermaid's defaults, so they are written out here.
 */
const SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "themeCSS",
  "themeVariables",
  "fontFamily",
  "altFontFamily",
  "htmlLabels",
  "flowchart",
  "dompurifyConfig",
  "theme",
  "darkMode",
  "look",
];

/**
 * Labels stay SVG text (`htmlLabels: false`) and the system font stack measures and paints them: the diagram is shown as
 * an image, which cannot load pap's web fonts, so a web font would be measured here and replaced there.
 */
function configOf(theme: "dark" | "neutral") {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    maxTextSize: MAX_DIAGRAM_CHARS,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    theme,
    secure: SECURE_KEYS,
  };
}

/** Dark on the night and high-contrast themes (both `color-scheme: dark`), else Mermaid's neutral. */
const themeNow = (): "dark" | "neutral" =>
  ["night", "hc"].includes(document.documentElement.getAttribute("data-theme") ?? "") ? "dark" : "neutral";

let initializedFor: "dark" | "neutral" | null = null;

/**
 * One diagram as the text of an SVG document, drawn inside `container` (the caller's own contained element) and never
 * inserted anywhere by this file. Mermaid initialises once per appearance, with the config above.
 */
export async function drawDiagram(id: string, code: string, container: Element): Promise<string> {
  const theme = themeNow();
  if (initializedFor !== theme) {
    mermaid.initialize(configOf(theme));
    initializedFor = theme;
  }
  const { svg } = await mermaid.render(id, code, container);
  return svg;
}
