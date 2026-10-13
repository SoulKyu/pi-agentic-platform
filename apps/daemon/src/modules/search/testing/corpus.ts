import type { Db } from "../../../kernel/db/database.ts";

/** The row cap of the index (`MAX_ROW_CHARS`): a test helper imports nothing from the module's internals. The corpus is ASCII. */
const ROW_CAP = 16_384;

interface CorpusRow {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly at: number;
  readonly text: string;
}

interface CorpusCursor {
  readonly path: string;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly offset: number;
  readonly skipLine: boolean;
  readonly head: string;
  readonly state: "indexed";
  readonly sessionId: string;
  readonly ownerId: string;
  readonly indexedChars: number;
}

/** What `createSearchIndexStore` gives: the real store writes the corpus, and sanitises every row again. */
interface CorpusStore {
  commit(cursor: CorpusCursor, rows: readonly CorpusRow[]): void;
}

export interface CorpusShape {
  readonly sessions: number;
  readonly rows: number;
  readonly chars: number;
  /** Rows over 2 000 characters: the heavy tail of a long assistant answer. */
  readonly longRows: number;
}

const VOCABULARY = 50_000;
const ZIPF_EXPONENT = 1.07;
const MAX_ROWS = 2_000;
const MAX_WORDS = 2_400;
const BASE_AT = Date.parse("2026-01-01T00:00:00Z");
const CONSONANTS = "bcdfghjklmnpqrstvwxz"; // 20
const VOWELS = "aeiou"; // 5: 100 syllables

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A standard normal by Box-Muller. */
export function normal(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/** Word `i`: the base-100 digits of `i + 100`, one consonant-vowel syllable each: unique, at least two syllables. */
export function wordAt(index: number): string {
  let rest = index + 100;
  let word = "";
  while (rest > 0) {
    const digit = rest % 100;
    word = `${CONSONANTS[Math.floor(digit / 5)] ?? ""}${VOWELS[digit % 5] ?? ""}${word}`;
    rest = Math.floor(rest / 100);
  }
  return word;
}

function zipfTable(): Float64Array {
  const table = new Float64Array(VOCABULARY);
  let sum = 0;
  for (let rank = 1; rank <= VOCABULARY; rank++) {
    sum += 1 / rank ** ZIPF_EXPONENT;
    table[rank - 1] = sum;
  }
  return table;
}

function drawRank(table: Float64Array, random: () => number): number {
  const target = random() * (table[VOCABULARY - 1] ?? 1);
  let low = 0;
  let high = VOCABULARY - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((table[mid] ?? 0) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

const between = (random: () => number, from: number, to: number): number =>
  from + Math.floor(random() * (to - from + 1));

/** The 50 queries of the budget test, by vocabulary rank (1 = the most frequent word). */
function queriesOf(random: () => number): string[] {
  const word = (rank: number) => wordAt(rank - 1);
  const mid = () => between(random, 200, 1_000);
  const rare = () => between(random, 20_000, VOCABULARY);
  return [
    ...Array.from({ length: 20 }, () => `${word(mid())} ${word(mid())}`),
    ...Array.from({ length: 10 }, () => word(rare())),
    ...Array.from({ length: 10 }, () => word(mid()).slice(0, 3)),
    ...Array.from({ length: 10 }, () => `${word(between(random, 1, 10))} ${word(rare())}`),
  ];
}

/**
 * A deterministic, heavy-tailed corpus shaped like a heavy Pi user's (owner Q6, RT-10), written through the real store,
 * one transaction in all, one commit per session. Rows per session `20 + floor(e^(ln 60 + z))` (cap 2 000); words per row
 * `floor(e^(ln 12 + 1.2 z))` (cap 2 400); words drawn with Zipf weights from a vocabulary of 50 000.
 */
export function buildCorpus(
  store: CorpusStore,
  db: Db,
  options: { sessions: number; seed: number },
): { queries: string[]; shape: CorpusShape } {
  const random = mulberry32(options.seed);
  const table = zipfTable();
  const words = Array.from({ length: VOCABULARY }, (_, index) => wordAt(index));
  let rows = 0;
  let chars = 0;
  let longRows = 0;
  db.transaction(() => {
    for (let n = 0; n < options.sessions; n++) {
      const count = Math.min(MAX_ROWS, 20 + Math.floor(Math.exp(Math.log(60) + normal(random))));
      const entries: CorpusRow[] = [];
      for (let i = 0; i < count; i++) {
        const length = Math.min(
          MAX_WORDS,
          Math.max(1, Math.floor(Math.exp(Math.log(12) + 1.2 * normal(random)))),
        );
        const parts: string[] = [];
        for (let w = 0; w < length; w++) parts.push(words[drawRank(table, random)] ?? "");
        const text = parts.join(" ").slice(0, ROW_CAP);
        chars += text.length;
        if (text.length > 2_000) longRows++;
        entries.push({
          entryId: `e${n}-${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          at: BASE_AT + i,
          text,
        });
      }
      rows += entries.length;
      const path = `/corpus/${n % 200}/s${n}.jsonl`;
      const cursor: CorpusCursor = {
        path,
        ino: n + 1,
        size: chars,
        mtimeMs: BASE_AT,
        offset: chars,
        skipLine: false,
        head: `{"type":"session","id":"s${n}"}`,
        state: "indexed",
        sessionId: `s${n}`,
        ownerId: "u1",
        indexedChars: 0,
      };
      store.commit(cursor, entries);
    }
  });
  return { queries: queriesOf(random), shape: { sessions: options.sessions, rows, chars, longRows } };
}
