/** An `@` before the caret and the characters typed after it. */
export interface Mention {
  readonly start: number;
  readonly query: string;
}

const BLANK = /\s/;

/** The mention the caret is in: an `@` at the start or after a blank, with no blank between it and the caret. */
export function mentionAt(text: string, caret: number): Mention | null {
  for (let index = caret - 1; index >= 0; index--) {
    const char = text.charAt(index);
    if (BLANK.test(char)) return null;
    if (char === "@") {
      if (index > 0 && !BLANK.test(text.charAt(index - 1))) return null;
      return { start: index, query: text.slice(index + 1, caret) };
    }
  }
  return null;
}

/** `@path`, or `@"path"` when the path holds a blank. */
export function mentionText(path: string): string {
  return BLANK.test(path) ? `@"${path}"` : `@${path}`;
}

/** Puts `mention` (already formatted) where the query was, then one space; the caret lands after it. */
export function insertMention(
  text: string,
  at: Mention,
  mention: string,
): { readonly text: string; readonly caret: number } {
  const head = `${text.slice(0, at.start)}${mention} `;
  return { text: `${head}${text.slice(at.start + 1 + at.query.length)}`, caret: head.length };
}

/** `absolute` as seen from the folder `from`: POSIX, with `../` when it lies above. Both are absolute. */
export function relativePath(from: string, absolute: string): string {
  const base = from.split("/").filter(Boolean);
  const target = absolute.split("/").filter(Boolean);
  let shared = 0;
  while (shared < base.length && shared < target.length - 1 && base[shared] === target[shared]) shared++;
  return [...Array<string>(base.length - shared).fill(".."), ...target.slice(shared)].join("/");
}

/** A search result (relative to the project root) as the text after `@`, relative to the session folder. */
export function mentionPath(rootRelative: string, root: string, folder: string): string {
  return relativePath(folder, `${root.replace(/\/+$/, "")}/${rootRelative}`);
}

/** Puts `mention` (already formatted) at the caret, a blank before it when the character before is not one. */
export function insertAt(
  text: string,
  caret: number,
  mention: string,
): { readonly text: string; readonly caret: number } {
  const lead = caret > 0 && !BLANK.test(text.charAt(caret - 1)) ? " " : "";
  const head = `${text.slice(0, caret)}${lead}${mention} `;
  return { text: `${head}${text.slice(caret)}`, caret: head.length };
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** A path with a control or invisible character is never offered: it would break the line or hide what it says. */
export const isShowable = (path: string): boolean => !INVISIBLE.test(path);
