/**
 * A diff side as visible text: control, bidi, zero-width and lookalike blank characters are written as `\uXXXX`, so a
 * line of the lane's files cannot reorder or hide what is around it. Line breaks (`\n`, and `\r\n` as one), tabs and
 * plain spaces stay; a lone `\r` is written out, so the editor counts lines as git does.
 */
export function showHidden(text: string): string {
  return text.replace(/\r\n|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu, (character) => {
    if (character === "\r\n" || character === "\n" || character === "\t" || character === " ")
      return character;
    const hex = (character.codePointAt(0) ?? 0).toString(16).toUpperCase();
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  });
}
