# Search: measured budgets

Both budgets live in `budgets.json` and are measured headless by `pnpm test:budget` (`PAP_BUDGET_RUN=1`, the two files below). The default `pnpm test:int` runs the same files without the wall-clock assertions: `search.budget.int.test.ts` on a 300-session corpus (plumbing and shape only), `scanner.exit.int.test.ts` with a 30 s wait. `pnpm budgets` only names the two budgets.

## Search latency (`searchP95Ms` = 200)

`apps/daemon/src/modules/search/search.budget.int.test.ts` builds a deterministic corpus (`testing/corpus.ts`, mulberry32 seed 42, temp dir removed in `afterAll`, about 60 to 80 s and 400 MB of disk) shaped like a heavy Pi user's. After one warm-up query of each kind it runs the 50 `search.query`-shaped round trips through the real worker thread three times and takes each query's best time; the p95 is over those 50 minimums. Every query must return at least one row.

- Corpus: 10 000 sessions, 1 188 251 rows, 147 979 324 indexed characters, 2 249 rows over 2 000 characters. Rows per session `20 + floor(e^(ln 60 + z))` (cap 2 000), words per row `floor(e^(ln 12 + 1.2 z))` (cap 2 400), 50 000 words with Zipf weights `1/rank^1.07`.
- Queries: 20 two-word mid-frequency, 10 rare words, 10 three-letter prefixes of mid words (the minimum prefix), 10 pairs of a very common and a rare word.
- Measured (6-core dev host, `/tmp` on tmpfs): p50 7 to 9 ms; p95 99.3, 101 and 132 ms over three single-pass runs, 97.1 ms best-of-3 in the first `pnpm test:budget` run.
- Caveat: the mix has no very common single word and no very common prefix. The slowest queries are always the three-letter prefixes (about 240 to 440 ms single-pass, they expand to many terms), and the p95 is the third slowest of 50, so the prefix queries drive it. A user typing `the` or `con` on a real corpus is not covered by this number.
- Index size: 404 324 352 bytes, 2.73 bytes per indexed character, about 40 KB per session. There is no global cap (owner Q14). Whether the per-file cap (`MAX_INDEXED_CHARS`, 1 M, with `SEARCH_SCHEMA_VERSION` = 2) is lowered is decided from the preview's `search_index_size` boot line (M4R128: above 1 GiB), not from this test.

## CLI session latency (`scannerLatencyMs` = 3000)

`scanner.exit.int.test.ts` writes a session with Pi's own `SessionManager` under the test daemon's temporary agent folder and times it to the `session` event on the `shell` stream over a real `fs.watch` (measured about 1008 to 1009 ms; the budget is asserted in `pnpm test:budget` only). The reconcile finds a lost event within 60 s. A session dated before the install is read and marked `excluded` in `search.db`, and never appears on the stream or in search.
