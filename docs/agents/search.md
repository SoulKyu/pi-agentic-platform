# Search: measured budgets

Both budgets live in `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/budgets.json` and are measured headless by integration tests (`pnpm test:int`); `pnpm budgets` only names them.

## Search latency (`searchP95Ms` = 200)

`apps/daemon/src/modules/search/search.budget.int.test.ts` builds a deterministic corpus (`testing/corpus.ts`, mulberry32 seed 42, temp dir removed in `afterAll`, about 80 s and 400 MB of disk) shaped like a heavy Pi user's and times 50 `search.query`-shaped round trips through the real worker thread after 5 warm-up queries.

- Corpus: 10 000 sessions, 1 188 251 rows, 147 979 324 indexed characters, 2 249 rows over 2 000 characters. Rows per session `20 + floor(e^(ln 60 + z))` (cap 2 000), words per row `floor(e^(ln 12 + 1.2 z))` (cap 2 400), 50 000 words with Zipf weights `1/rank^1.07`.
- Queries: 20 two-word mid-frequency, 10 rare words, 10 three-letter prefixes (the minimum prefix), 10 pairs of a very common and a rare word.
- Measured (6-core dev host, `/tmp` on tmpfs): p50 8 ms, p95 100 to 132 ms over two runs. The slowest queries are always the three-letter prefixes (about 250 to 440 ms), which expand to many terms; the p95 is the third slowest of 50.
- Index size: 404 324 352 bytes, 2.73 bytes per indexed character, about 40 KB per session. There is no global cap (owner Q14); the boot line `search_index_size` logs the real size. If the preview's index is above 1 GiB, the lever is `MAX_INDEXED_CHARS` = 1 000 000 plus `SEARCH_SCHEMA_VERSION` = 2 (M4R128).

## CLI session latency (`scannerLatencyMs` = 3000)

`scanner.exit.int.test.ts` writes a session with Pi's own `SessionManager` under the test daemon's temporary agent folder and times it to the `session` event on the `shell` stream over a real `fs.watch`. The reconcile finds a lost event within 60 s. A session dated before the install is read and marked `excluded` in `search.db`, and never appears on the stream or in search.
