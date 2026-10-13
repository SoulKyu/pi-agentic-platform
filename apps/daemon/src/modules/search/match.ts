import { DatabaseSync } from "node:sqlite";
import { cutUnits } from "../../kernel/text.ts";

// Letters, digits and combining marks. FTS5 tokenizes each quoted term again with unicode61 (default categories
// `L* N* Co`, marks are separators there), so a mark here only keeps a word in one piece (RT-44).
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;
export const MAX_QUERY_TERMS = 8;
const MAX_TERM_UNITS = 64;
/** A shorter prefix expands to thousands of terms on a real index (RT-10, owner Q6). */
export const MIN_PREFIX_POINTS = 3;

const WORD_CHARS = /[\p{L}\p{N}]/gu;
const MARKS = /\p{M}/u;
let probe: DatabaseSync | undefined;
const splitsMemo = new Map<string, boolean>();

/**
 * Whether FTS5's own tokenizer (unicode61, remove_diacritics 2) ends a word at this mark. Asked of the real tokenizer
 * rather than a hard-coded table, which depends on the SQLite build's Unicode version (I1).
 */
function splitsWords(mark: string): boolean {
  const known = splitsMemo.get(mark);
  if (known !== undefined) return known;
  if (probe === undefined) {
    probe = new DatabaseSync(":memory:");
    probe.exec(
      "CREATE VIRTUAL TABLE probe USING fts5(text, tokenize='unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE probe_terms USING fts5vocab(probe, 'row')",
    );
  }
  probe.exec("DELETE FROM probe");
  probe.prepare("INSERT INTO probe VALUES (?)").run(`ab${mark}cd`);
  const terms = (probe.prepare("SELECT count(*) AS n FROM probe_terms").get() as { n: number }).n;
  splitsMemo.set(mark, terms > 1);
  return terms > 1;
}

/** The characters FTS5 will see in the last token a prefix would expand: after the last separator mark, none after. */
function prefixPoints(token: string): number {
  let piece = "";
  for (const char of token) {
    if (MARKS.test(char) && splitsWords(char)) piece = "";
    else piece += char;
  }
  return piece.match(WORD_CHARS)?.length ?? 0;
}

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
      return isLast && typing && prefixPoints(token) >= MIN_PREFIX_POINTS ? `${quoted}*` : quoted;
    })
    .join(" AND ");
}
