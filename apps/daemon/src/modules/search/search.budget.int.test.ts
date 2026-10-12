import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { indexBytes, openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore } from "./index-store.ts";
import { matchExpression } from "./match.ts";
import { createSearchClient, type SearchClient } from "./search-client.ts";
import { buildCorpus, type CorpusShape } from "./testing/corpus.ts";

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../budgets.json", import.meta.url)), "utf8"),
) as { searchP95Ms: number };

/** `pnpm test:budget` sets this: 10 000 sessions and the wall-clock budget. The default `test:int` checks the plumbing on a small corpus. */
const BUDGET_RUN = process.env.PAP_BUDGET_RUN === "1";
const SESSIONS = BUDGET_RUN ? 10_000 : 300;
const PASSES = 3;
/** One query of each kind (two mid words, a rare word, a 3-letter prefix, a common and a rare word), before measuring. */
const WARM_UP = [0, 20, 30, 40];

let dir = "";
let client: SearchClient | null = null;
let queries: string[] = [];
let shape: CorpusShape;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-search-budget-"));
  const db = openSearchIndex(join(dir, "search.db"), silentLogger);
  const started = performance.now();
  try {
    ({ queries, shape } = buildCorpus(createSearchIndexStore(db), db, { sessions: SESSIONS, seed: 42 }));
  } finally {
    db.close();
  }
  const bytes = indexBytes(join(dir, "search.db"));
  console.log(
    `search corpus: ${shape.sessions} sessions, ${shape.rows} rows, ${shape.chars} characters, ${shape.longRows} rows over 2 000 characters; ` +
      `index ${bytes} bytes (${(bytes / shape.chars).toFixed(2)} bytes per indexed character, ${Math.round(bytes / shape.sessions)} per session); built in ${Math.round((performance.now() - started) / 1000)} s`,
  );
  client = createSearchClient({
    dbPath: join(dir, "search.db"),
    clock: createSystemClock(),
    logger: silentLogger,
  });
}, 300_000);

afterAll(async () => {
  try {
    await client?.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const run = (q: string) => {
  const match = matchExpression(q);
  if (match === null) throw new Error(`query ${JSON.stringify(q)} has no match expression`);
  return (client as SearchClient).query({ match, ownerId: "u1", limit: 20 });
};

it("builds the 50 queries and the corpus of the budget run, and the worker thread answers them", async () => {
  expect(queries).toHaveLength(50);
  expect(shape.sessions).toBe(SESSIONS);
  expect(shape.rows).toBeGreaterThan(SESSIONS * 20);
  for (const q of queries) expect(matchExpression(q)).not.toBeNull();
  const rows = await run(queries[0] ?? "");
  expect(rows.length).toBeLessThanOrEqual(20);
});

it.runIf(BUDGET_RUN)(
  "answers a search over 10 000 realistic sessions within its p95 budget",
  async () => {
    for (const index of WARM_UP) await run(queries[index] ?? "");
    const best = queries.map(() => Number.POSITIVE_INFINITY);
    for (let pass = 0; pass < PASSES; pass++) {
      for (const [index, q] of queries.entries()) {
        const started = performance.now();
        const rows = await run(q);
        best[index] = Math.min(best[index] ?? Number.POSITIVE_INFINITY, performance.now() - started);
        expect(rows.length, q).toBeGreaterThanOrEqual(1);
        expect(rows.length).toBeLessThanOrEqual(20);
      }
    }
    const times = [...best].sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    const p50 = times[Math.ceil(times.length * 0.5) - 1] ?? Number.POSITIVE_INFINITY;
    const slowest = queries
      .map((q, index) => ({ q, ms: best[index] ?? 0 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5);
    console.log(
      `search: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${queries.length} queries, best of ${PASSES} passes (budget ${budgets.searchP95Ms}); ` +
        `slowest ${slowest.map((entry) => `${JSON.stringify(entry.q)} ${entry.ms.toFixed(0)} ms`).join(", ")}`,
    );
    expect(shape.rows).toBeGreaterThan(1_000_000);
    expect(p95).toBeLessThanOrEqual(budgets.searchP95Ms);
  },
  300_000,
);
