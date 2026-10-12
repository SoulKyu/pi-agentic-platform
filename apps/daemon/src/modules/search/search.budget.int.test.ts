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

let dir = "";
let client: SearchClient | null = null;
let queries: string[] = [];
let shape: CorpusShape;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-search-budget-"));
  const db = openSearchIndex(join(dir, "search.db"), silentLogger);
  const started = performance.now();
  ({ queries, shape } = buildCorpus(createSearchIndexStore(db), db, { sessions: 10_000, seed: 42 }));
  db.close();
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

it("answers a search over 10 000 realistic sessions within its p95 budget", async () => {
  const run = (q: string) =>
    (client as SearchClient).query({ match: matchExpression(q) ?? '""', ownerId: "u1", limit: 20 });
  for (const q of queries.slice(0, 5)) await run(q);
  const timed: Array<{ q: string; ms: number }> = [];
  for (const q of queries) {
    const started = performance.now();
    const rows = await run(q);
    timed.push({ q, ms: performance.now() - started });
    expect(rows.length).toBeLessThanOrEqual(20);
  }
  const times = timed.map((entry) => entry.ms).sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  const p50 = times[Math.ceil(times.length * 0.5) - 1] ?? Number.POSITIVE_INFINITY;
  const slowest = [...timed].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log(
    `search: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${queries.length} queries (budget ${budgets.searchP95Ms}); ` +
      `slowest ${slowest.map((entry) => `${JSON.stringify(entry.q)} ${entry.ms.toFixed(0)} ms`).join(", ")}`,
  );
  expect(queries).toHaveLength(50);
  expect(shape.rows).toBeGreaterThan(1_000_000);
  expect(p95).toBeLessThanOrEqual(budgets.searchP95Ms);
}, 120_000);
