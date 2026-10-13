export type FencePart =
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "fenced"; readonly source: string; readonly text: string };

/** Openings tried per text: each one scans for its closing, so a forged flood must not cost a quadratic search. */
export const MAX_FENCE_OPENINGS = 64;

// pap's format (pi-host policy/fence.ts): `<untrusted source="S" id="H">\n` text `\n</untrusted id="H">`, H = 12 hex.
const OPENING = '<untrusted source="([A-Za-z0-9_.-]{1,64})" id="([0-9a-f]{12})">\\n';
const CLOSING = '</untrusted id="[0-9a-f]{12}">';

/**
 * Splits a tool output on pap's fences. Only an opening whose exact id closes it counts; the model's text never decides
 * what is fenced, so anything else (a forged closing, an unclosed opening, a wrong id) stays plain text.
 */
export function splitFences(text: string): FencePart[] {
  const opening = new RegExp(OPENING, "g");
  const parts: FencePart[] = [];
  let plainFrom = 0;
  let scanFrom = 0;
  for (let tried = 0; tried < MAX_FENCE_OPENINGS; tried += 1) {
    opening.lastIndex = scanFrom;
    const found = opening.exec(text);
    if (found === null) break;
    const [marker, source = "", id = ""] = found;
    const bodyFrom = found.index + marker.length;
    const closing = `\n</untrusted id="${id}">`;
    const closeAt = text.indexOf(closing, bodyFrom);
    if (closeAt === -1) {
      scanFrom = found.index + 1;
      continue;
    }
    if (found.index > plainFrom) parts.push({ kind: "plain", text: text.slice(plainFrom, found.index) });
    parts.push({ kind: "fenced", source, text: text.slice(bodyFrom, closeAt) });
    plainFrom = scanFrom = closeAt + closing.length;
  }
  if (plainFrom < text.length) parts.push({ kind: "plain", text: text.slice(plainFrom) });
  return parts;
}

/** A clipped one-line preview may hold only one end of a fence: pap's own markers are removed, look-alikes stay. */
export const stripFenceMarkers = (preview: string): string =>
  preview.replace(new RegExp(OPENING, "g"), "").replace(new RegExp(CLOSING, "g"), "");
