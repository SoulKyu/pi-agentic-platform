import type { ResponseFrame } from "@pap/contracts";
import { afterEach, expect, it } from "vitest";
import { createSystemClock } from "./kernel/clock.ts";
import { createLogger } from "./kernel/logger.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

let t: TestDaemon | undefined;
let client: TestClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  await t?.stop();
  t = undefined;
});

const resultOf = <T>(frame: ResponseFrame): T => {
  if (!frame.ok) throw new Error(`call failed: ${frame.error.code}`);
  return frame.result as T;
};

it("answers search.query on a fresh home, refuses an empty query, and says the index size once at boot", async () => {
  const lines: string[] = [];
  const logger = createLogger({
    level: "info",
    clock: createSystemClock(),
    write: (line) => lines.push(line),
  });
  t = await startTestDaemon({ steps: [] }, { deps: { logger } });
  client = await t.connect(await t.login());

  expect(resultOf(await client.call("search.query", { q: "kubernetes" }))).toEqual({ hits: [] });
  const refused = await client.call("search.query", { q: "" });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error.code).toBe("bad_request");

  const sizes = lines
    .map((line) => JSON.parse(line) as { msg: string; bytes: number; rows: number })
    .filter((entry) => entry.msg === "search_index_size");
  expect(sizes).toHaveLength(1);
  const fields = sizes[0] ?? { bytes: 0, rows: -1 };
  expect(fields.bytes).toBeGreaterThan(0);
  expect(fields.rows).toBe(0);
});
