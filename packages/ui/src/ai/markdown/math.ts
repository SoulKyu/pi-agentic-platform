import katex from "katex";
import "katex/dist/katex.min.css";

const MAX_SIZE_EM = 2;

/**
 * TeX to KaTeX's markup, loaded on first use (`MathBlock` imports this file lazily, with its stylesheet and fonts).
 * `trust: false` keeps \href, \url, \htmlClass, \htmlStyle, \htmlData and \includegraphics as source; `maxExpand`
 * bounds macro loops; a formula KaTeX cannot read is shown as its source. `maxSize: 2` caps a POSITIVE size the formula
 * gives itself (`\rule{20em}{20em}` draws 2 em) and nothing else: KaTeX lets a negative size through (`\raisebox{-15em}{x}`,
 * `\kern-30em`) and sizes built by macros or by repetition add up. It is not the guarantee. The guarantee is the box:
 * `MathBlock` paints every formula inside `contain-rich` / `contain-rich-inline` (`contain: paint`, UX2-R81), so nothing
 * KaTeX draws, however far it is offset, paints outside it. Whether the paint stays inside is proven in a browser (J18).
 */
export function renderTex(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    errorColor: "currentColor",
    trust: false,
    strict: "ignore",
    maxExpand: 1000,
    maxSize: MAX_SIZE_EM,
    output: "htmlAndMathml",
  });
}
