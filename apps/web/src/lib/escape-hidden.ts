const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu;

/**
 * A repository string as visible text (M7R86, M7R99): control, bidi, zero-width and lookalike blank characters
 * are written as `\uXXXX`, so a name cannot reorder or hide what is around it. A plain space stays.
 */
export const escapeHidden = (text: string): string =>
  text.replace(HIDDEN, (character) => {
    if (character === " ") return character;
    const hex = (character.codePointAt(0) ?? 0).toString(16).toUpperCase();
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  });
