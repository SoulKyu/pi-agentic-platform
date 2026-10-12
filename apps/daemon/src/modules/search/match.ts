import { cutUnits } from "../../kernel/text.ts";

// Letters, digits and combining marks. FTS5 tokenizes each quoted term again with unicode61 (default categories
// `L* N* Co`, marks are separators there), so a mark here only keeps a word in one piece (RT-44).
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;
export const MAX_QUERY_TERMS = 8;
const MAX_TERM_UNITS = 64;
/** A shorter prefix expands to thousands of terms on a real index (RT-10, owner Q6). */
export const MIN_PREFIX_POINTS = 3;

/**
 * The FTS5 MATCH expression for what a person typed (M4R47): every word quoted, all of them required, the last one a
 * prefix while it is being typed — when it is the input's last word, nothing follows it, and it has at least 3 code
 * points. Nothing else of the input reaches FTS5. Null when no word is left.
 */
export function matchExpression(query: string): string | null {
  const text = query.normalize("NFKC");
  const found = [...text.matchAll(TOKEN)];
  const last = found.at(-1);
  if (last === undefined) return null;
  const typing = found.length <= MAX_QUERY_TERMS && last.index + last[0].length === text.length;
  const tokens = found.slice(0, MAX_QUERY_TERMS).map((match) => cutUnits(match[0], MAX_TERM_UNITS));
  return tokens
    .map((token, index) => {
      const quoted = `"${token.replaceAll('"', '""')}"`;
      const isLast = index === tokens.length - 1;
      return isLast && typing && [...token].length >= MIN_PREFIX_POINTS ? `${quoted}*` : quoted;
    })
    .join(" AND ");
}
