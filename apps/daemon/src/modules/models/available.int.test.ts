import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AvailableModels } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createHelperPool, type HelperPool } from "../../kernel/helper/pool.ts";
import { type LogFields, type Logger, silentLogger } from "../../kernel/logger.ts";
import { createPiWriteQueue } from "../../kernel/pi-write-queue.ts";
import { testCaller } from "../../testing/caller.ts";
import { createModelsModule } from "./index.ts";
import { signInDeps } from "./testing/bed.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/helper/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
const EXEC_ARGV = [
  "--conditions=development",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];

let root: string;
let agentDir: string;
let pool: HelperPool;
let availableRuns: number;
let logs: Array<{ msg: string; fields: LogFields | undefined }>;
const logger: Logger = { ...silentLogger, warn: (msg, fields) => void logs.push({ msg, fields }) };

/** The module as `compose-pi.ts` builds it (same factory, same deps, the pool counted), not a hand-made service. */
const moduleOf = () =>
  createModelsModule({
    helpers: {
      ...pool,
      run: (op, params, options) => {
        if (op === "models.available") availableRuns++;
        return pool.run(op, params, options);
      },
    },
    projects: { covers: () => true },
    logger,
    ...signInDeps,
    writes: createPiWriteQueue(),
  });
const ctx = (stepUp = false) =>
  ({ caller: testCaller(stepUp ? { stepUpUntil: signInDeps.clock.now() + 60_000 } : {}) }) as never;
const providersOf = (listing: AvailableModels) => new Set(listing.models.map((model) => model.provider));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-available-int-")));
  agentDir = join(root, "home", ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "pap"));
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-TEST-KEY" } }),
  );
  availableRuns = 0;
  logs = [];
  pool = createHelperPool({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    baseEnv: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home"), PI_OFFLINE: "1" },
    agentDir,
    papHome: join(root, "pap"),
    max: 2,
    clock: createSystemClock(),
    logger,
  });
});
afterEach(async () => {
  try {
    await pool.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(JSON.stringify(logs)).not.toContain("pap-network-guard: blocked");
});

describe("models.available through the daemon module and a real helper", () => {
  it("lists the models of the signed-in provider and no other, then serves the cache", async () => {
    const rpc = moduleOf().rpc;
    const first = await rpc["models.available"]({}, ctx());
    expect(first.origin).toBe("signed-in");
    expect(providersOf(first)).toEqual(new Set(["anthropic"]));
    expect(await rpc["models.available"]({}, ctx())).toEqual(first);
    expect(availableRuns).toBe(1);
  });

  it("changes its next answer after setEnabled switches a provider off", { timeout: 60_000 }, async () => {
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: "sk-ant-TEST-KEY" },
        openai: { type: "api_key", key: "sk-TEST-OPENAI" },
      }),
    );
    const rpc = moduleOf().rpc;
    expect(providersOf(await rpc["models.available"]({}, ctx()))).toEqual(new Set(["anthropic", "openai"]));
    await rpc["models.setEnabled"]({ op: { op: "provider", provider: "anthropic", enabled: false } }, ctx());
    const after = await rpc["models.available"]({}, ctx());
    expect(availableRuns).toBe(2);
    expect(after.origin).toBe("scope");
    expect(providersOf(after)).toEqual(new Set(["openai"]));
  });

  it("lists a second provider at once after a real setApiKey", async () => {
    const rpc = moduleOf().rpc;
    expect(providersOf(await rpc["models.available"]({}, ctx()))).toEqual(new Set(["anthropic"]));
    await rpc["models.setApiKey"]({ provider: "openai", key: "sk-TEST-OPENAI" }, ctx(true));
    expect(providersOf(await rpc["models.available"]({}, ctx()))).toEqual(new Set(["anthropic", "openai"]));
    await rpc["models.logout"]({ provider: "openai" }, ctx());
    expect(providersOf(await rpc["models.available"]({}, ctx()))).toEqual(new Set(["anthropic"]));
    expect(availableRuns).toBe(3);
  });

  it("costs one helper run for four concurrent first calls and none ends in capacity", async () => {
    const rpc = moduleOf().rpc;
    const all = await Promise.all([1, 2, 3, 4].map(() => rpc["models.available"]({}, ctx())));
    expect(availableRuns).toBe(1);
    expect(new Set(all.map((listing) => JSON.stringify(listing))).size).toBe(1);
    expect(all[0]?.models.length).toBeGreaterThan(0);
  });

  it("never runs a !command key of auth.json when the picker lists", async () => {
    const marker = join(root, "marker-ran");
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: `!touch ${marker}` } }),
    );
    const listing = await moduleOf().rpc["models.available"]({}, ctx());
    expect(listing.models.length).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
  });
});
