/** Limits of a clipped text: whichever is reached first cuts it. */
export interface ClipLimits {
  readonly lines: number;
  readonly chars: number;
}

/** Bidi and other invisible control characters are removed from extension and policy text; tab and newline stay (M2-RT-42). */
export const plain = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === "\t" || character === "\n" ? character : "",
  );

/** The part of `text` that fits `limits`, cut on a line or character boundary, with an ellipsis when something is left out. */
export function clip(
  text: string,
  limits: ClipLimits,
): { readonly shown: string; readonly clipped: boolean } {
  let end = text.length;
  let newline = -1;
  let found = 0;
  while (found < limits.lines) {
    newline = text.indexOf("\n", newline + 1);
    if (newline === -1) break;
    found += 1;
  }
  if (found === limits.lines) end = newline;
  if (end > limits.chars) {
    end = limits.chars;
    // Never cut a surrogate pair in half.
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return end < text.length
    ? { shown: `${text.slice(0, end)}…`, clipped: true }
    : { shown: text, clipped: false };
}
