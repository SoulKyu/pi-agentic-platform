import { appendFileSync } from "node:fs";

// Test only, loaded into every pi-host worker with `--import` (see `spawnCounting` in agent-bed.ts): one line per worker
// that started, so a test can say "no worker was spawned" and mean it. Nothing is written when the variable is absent.
const file = process.env["TEST_SPAWN_LOG"];
if (file !== undefined && file !== "") appendFileSync(file, `${process.pid}\n`);
