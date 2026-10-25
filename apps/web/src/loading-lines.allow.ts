/** Files allowed to keep a loading line of their own. Each entry says why; `loading-lines.test.ts` refuses an entry whose file no longer needs it. */
export const LOADING_LINE_ALLOWED: readonly { readonly file: string; readonly reason: string }[] = [];
