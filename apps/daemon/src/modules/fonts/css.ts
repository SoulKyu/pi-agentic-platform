/** Reads the stylesheet Google answers with. Only what pap itself would write is kept; the rest is never fetched or copied. */
export interface GoogleFace {
  readonly url: string;
  readonly weight: string;
  readonly unicodeRange: string | null;
  /** The `/* latin *\/` label Google puts before each block, when there is one. */
  readonly subset: string | null;
}

const STRICT_URL = /^https:\/\/fonts\.gstatic\.com\/[A-Za-z0-9/_.-]{1,200}\.woff2$/;
const WEIGHT = /^\d{3}(?: \d{3})?$/;
const RANGE_ITEM = "U\\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?";
const RANGE = new RegExp(`^${RANGE_ITEM}(?:\\s*,\\s*${RANGE_ITEM})*$`);
const MAX_RANGE = 2000;
const MAX_BLOCKS = 512;
// Real blocks are about 250 bytes. A longer one is never scanned: the declaration regexes would rescan it from every match.
const MAX_BLOCK_CHARS = 2048;
const BLOCK = /(?:\/\*\s*([a-z0-9-]{1,32})\s*\*\/\s*)?@font-face\s*\{([^{}]*)\}/g;

const declaration = (block: string, name: string): string | undefined =>
  new RegExp(`(?:^|[\\s;{])${name}\\s*:\\s*([^;]*);`).exec(block)?.[1]?.trim();

function faceOf(block: string, subset: string | null): GoogleFace | null {
  if (block.split("url(").length !== 2) return null; // exactly one url(): a second source is never followed
  const style = declaration(block, "font-style");
  if (style !== undefined && style !== "normal") return null;
  const weight = declaration(block, "font-weight");
  if (weight === undefined || !WEIGHT.test(weight)) return null;
  const range = declaration(block, "unicode-range");
  if (range !== undefined && (range.length > MAX_RANGE || !RANGE.test(range))) return null;
  const url = /url\(\s*(["']?)([^)"'\s]*)\1\s*\)/.exec(block)?.[2];
  if (url === undefined || !STRICT_URL.test(url) || url.includes("..")) return null;
  return { url, weight, unicodeRange: range ?? null, subset };
}

/** `dropped` counts the blocks that were not kept, whatever the reason. */
export function parseGoogleCss(css: string): { faces: GoogleFace[]; dropped: number } {
  const faces: GoogleFace[] = [];
  let dropped = 0;
  let seen = 0;
  for (const match of css.matchAll(BLOCK)) {
    if (seen >= MAX_BLOCKS) {
      dropped += 1;
      continue;
    }
    seen += 1;
    const block = match[2] ?? "";
    const face = block.length > MAX_BLOCK_CHARS ? null : faceOf(block, match[1] ?? null);
    if (face === null) dropped += 1;
    else faces.push(face);
  }
  return { faces, dropped };
}

/** The family name Google wrote in the first block, only when it is the name the owner typed in other letters' case. */
export function googleFamilyName(css: string, typed: string): string {
  const written = /font-family\s*:\s*['"]?([A-Za-z0-9 ]{1,64})['"]?\s*;/.exec(css)?.[1]?.trim();
  return written !== undefined && written.toLowerCase() === typed.toLowerCase() ? written : typed;
}
