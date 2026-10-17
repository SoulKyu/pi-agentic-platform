import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { HandlerContext, HandlerTable } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createHelperPool, type HelperPool } from "../../kernel/helper/pool.ts";
import { createPiWriteQueue } from "../../kernel/pi-write-queue.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { AUDIT_MIGRATIONS, createAuditModule } from "../audit/index.ts";
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
let dispose: () => void;
let command = 0;
let audit: () => unknown[];
let receipts: () => unknown[];
let logLines: Array<Record<string, unknown>>;
let call: (
  method: string,
  params: unknown,
  stepUp?: boolean,
) => Promise<{ ok: boolean; [k: string]: unknown }>;
let answers: string[];

const ENV_VALUE = `ENV-VALUE-MARKER-${randomBytes(6).toString("hex")}`;
const providerBody = (over: Record<string, unknown> = {}) => ({
  id: "mine",
  api: "openai-completions",
  baseUrl: "http://localhost:11434/v1",
  auth: { kind: "stored" },
  headers: [],
  models: [{ id: "m1", name: "One" }],
  ...over,
});
const saveParams = (baseRevision: string, over: Record<string, unknown> = {}) => ({
  mode: "create",
  id: "mine",
  provider: providerBody(over),
  baseRevision,
});
const revision = async (id?: string) => {
  const answer = await call("models.provider.get", id === undefined ? {} : { id });
  return (answer.result as { revision: string }).revision;
};

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-provider-int-")));
  agentDir = join(root, "home", ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "pap"));
  mkdirSync(join(root, "state"));
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  logLines = lines;
  const db = migrate({
    dbPath: join(root, "state", "s.db"),
    backupsDir: join(root, "state", "b"),
    sources: [KERNEL_MIGRATIONS, AUDIT_MIGRATIONS],
    clock,
    logger,
  }).db;
  audit = () => db.all("SELECT * FROM audit");
  receipts = () => db.all("SELECT * FROM receipts");
  pool = createHelperPool({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    baseEnv: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      HOME: join(root, "home"),
      PI_OFFLINE: "1",
      FOO: ENV_VALUE,
    },
    agentDir,
    papHome: join(root, "pap"),
    max: 4,
    clock: createFakeClock(Date.now()),
    logger,
  });
  // The module as `compose-pi.ts` builds it: same factory, same queue type, real audit and receipt tables.
  const models = createModelsModule({
    helpers: pool,
    projects: { covers: () => true },
    logger,
    ...signInDeps,
    clock,
    audit: createAuditModule({ db, clock, logger }).port,
    writes: createPiWriteQueue(),
  });
  const dispatch = createDispatcher({
    handlers: models.rpc as unknown as HandlerTable,
    receipts: createReceiptStore(db, clock),
    logger,
  });
  answers = [];
  call = async (method, params, stepUp = true) => {
    const ctx: HandlerContext = {
      caller: testCaller(stepUp ? { stepUpUntil: clock.now() + 60_000 } : {}),
      connectionId: "c1",
      openSubscription: () => "s1",
      closeSubscription: () => {},
    };
    command++;
    const response = await dispatch({ id: command, method, params, commandId: `cmd-${command}-0001` }, ctx);
    answers.push(JSON.stringify(response));
    return response as never;
  };
  dispose = () => db.close();
});
afterEach(async () => {
  try {
    await pool.stopAll();
  } finally {
    dispose();
    rmSync(root, { recursive: true, force: true });
  }
  expect(JSON.stringify(logLines)).not.toContain("pap-network-guard: blocked");
});

/**
 * Every regular file under the temp root (state db and its wal, auth.json, models.json, settings.json, temp files)
 * read as bytes: where `needle` occurs, by path relative to the root, with its count.
 */
const filesHolding = (needle: string): Record<string, number> => {
  const found: Record<string, number> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const count = readFileSync(path).toString("latin1").split(needle).length - 1;
    if (count > 0) found[relative(root, path)] = count;
  }
  return found;
};
const AUTH = "home/.pi/agent/auth.json";
const MODELS = "home/.pi/agent/models.json";

/** Everything a marker must be absent from, serialised: logs, audit rows, receipts, every answer a client saw. */
const everywhereButTheFiles = () => JSON.stringify([logLines, audit(), receipts(), answers]);
const readReply = async () => {
  await call("models.provider.get", { id: "mine" });
  await call("models.config.get", {});
  await call("models.overview", {});
  await call("models.available", {});
};

describe("the key flow through the daemon's real tables and a real helper", () => {
  it(
    "key.marker.nowhere: a provider saved, then its key stored, leaves the key in auth.json only",
    {
      timeout: 90_000,
    },
    async () => {
      const marker = `sk-test-MARKER-${randomBytes(8).toString("hex")}`;
      const saved = await call(
        "models.provider.save",
        saveParams(await revision(), {
          headers: [{ name: "X-Team", value: { kind: "literal", text: "team-LITERAL-7" } }],
        }),
      );
      expect(saved.ok).toBe(true);
      expect((await call("models.setApiKey", { provider: "mine", key: marker })).ok).toBe(true);
      await readReply();
      // The whole temp root: once in total, in auth.json only (no db, wal, temp file or settings.json holds it).
      expect(filesHolding(marker)).toEqual({ [AUTH]: 1 });
      expect(statSync(join(agentDir, "auth.json")).mode & 0o777).toBe(0o600);
      expect(everywhereButTheFiles()).not.toContain(marker);
      expect(JSON.stringify(audit())).toContain("provider_saved");
      expect(JSON.stringify(audit())).toContain("provider_key_set");
      // A header literal is in models.json and in no log, audit row, receipt or answer.
      expect(filesHolding("team-LITERAL-7")).toEqual({ [MODELS]: 1 });
      expect(everywhereButTheFiles()).not.toContain("team-LITERAL-7");
    },
  );

  it(
    "an env key writes $FOO and the value of FOO reaches no file but the process env, no log, no answer",
    {
      timeout: 90_000,
    },
    async () => {
      const saved = await call(
        "models.provider.save",
        saveParams(await revision(), { auth: { kind: "env", name: "FOO" } }),
      );
      expect(saved.ok).toBe(true);
      const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
        providers: { mine: { apiKey?: string } };
      };
      expect(models.providers.mine.apiKey).toBe("$FOO");
      await readReply();
      expect(filesHolding(ENV_VALUE)).toEqual({});
      expect(everywhereButTheFiles()).not.toContain(ENV_VALUE);
    },
  );

  it(
    "remove with the key ticked takes the entry and the stored key, audits both, and the marker stays out",
    {
      timeout: 90_000,
    },
    async () => {
      const marker = `sk-test-MARKER-${randomBytes(8).toString("hex")}`;
      await call("models.provider.save", saveParams(await revision()));
      await call("models.setApiKey", { provider: "mine", key: marker });
      const removed = await call("models.provider.remove", {
        id: "mine",
        baseRevision: await revision("mine"),
        alsoRemoveKey: true,
      });
      expect(removed.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"))).toEqual({ providers: {} });
      expect(filesHolding(marker)).toEqual({});
      const rows = JSON.stringify(audit());
      expect(rows).toContain("provider_removed");
      expect(rows).toContain("provider_signed_out");
      expect(everywhereButTheFiles()).not.toContain(marker);
    },
  );

  it(
    "remove with the key ticked and no key stored removes the entry and answers ok, with no sign-out audit (I2)",
    { timeout: 90_000 },
    async () => {
      await call("models.provider.save", saveParams(await revision(), { auth: { kind: "none" } }));
      const removed = await call("models.provider.remove", {
        id: "mine",
        baseRevision: await revision("mine"),
        alsoRemoveKey: true,
      });
      expect(removed.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"))).toEqual({ providers: {} });
      const rows = JSON.stringify(audit());
      expect(rows).toContain("provider_removed");
      expect(rows).not.toContain("provider_signed_out");
    },
  );

  it("a removal without the tick leaves the stored key", { timeout: 90_000 }, async () => {
    const marker = `sk-test-MARKER-${randomBytes(8).toString("hex")}`;
    await call("models.provider.save", saveParams(await revision()));
    await call("models.setApiKey", { provider: "mine", key: marker });
    const removed = await call("models.provider.remove", {
      id: "mine",
      baseRevision: await revision("mine"),
      alsoRemoveKey: false,
    });
    expect(removed.ok).toBe(true);
    expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toContain(marker);
    expect(JSON.stringify(audit())).not.toContain("provider_signed_out");
  });

  it(
    "refuses save and remove without a recent password: nothing is written, audited or kept as a receipt",
    {
      timeout: 90_000,
    },
    async () => {
      const base = await revision();
      const refused = await call("models.provider.save", saveParams(base), false);
      expect(refused).toMatchObject({ ok: false, error: { code: "step_up_required" } });
      const refusedRemove = await call(
        "models.provider.remove",
        { id: "mine", baseRevision: base, alsoRemoveKey: false },
        false,
      );
      expect(refusedRemove).toMatchObject({ ok: false, error: { code: "step_up_required" } });
      expect(() => readFileSync(join(agentDir, "models.json"))).toThrow();
      expect(audit()).toEqual([]);
      expect(JSON.stringify(receipts())).not.toContain("models.provider");
    },
  );

  it(
    "three creates from the same revision: one wins, two get conflict, the file holds one provider",
    {
      timeout: 90_000,
    },
    async () => {
      const base = await revision();
      const results = await Promise.all(
        ["one", "two", "three"].map((id) =>
          call("models.provider.save", {
            mode: "create",
            id,
            provider: providerBody({ id }),
            baseRevision: base,
          }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => (r.error as { code: string }).code)).toEqual([
        "conflict",
        "conflict",
      ]);
      const file = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(Object.keys(file.providers)).toHaveLength(1);
    },
  );

  it(
    "a save is visible in the next models.available without waiting for the cache (MP-RT-06)",
    {
      timeout: 90_000,
    },
    async () => {
      const before = await call("models.available", {});
      expect(JSON.stringify(before)).not.toContain('"mine"');
      await call("models.provider.save", saveParams(await revision(), { auth: { kind: "none" } }));
      const after = await call("models.available", {});
      expect(JSON.stringify(after)).toContain('"mine"');
    },
  );
});
