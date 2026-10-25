import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createSettingsModule, SETTINGS_MIGRATIONS } from "../settings/index.ts";
import { PRICING_CACHE_MS } from "./pricing-cache.ts";
import { modelsBed } from "./testing/bed.ts";

const gpt5 = { provider: "openai", id: "gpt-5", input: 1.25, output: 10 };
const mini = { provider: "openai", id: "gpt-5-mini", input: 0.25, output: 2 };
/** The helper's answer: the entries asked for and the extracted map (M7R67 as read by MC34). */
const priced = { entries: [gpt5], catalog: [gpt5, mini] };
const answer = (entries: unknown[]) => ({ entries });
const caller = testCaller();
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

let root: string;
let db: Db;
let settings: ReturnType<typeof createSettingsModule>;
let lines: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-pricing-"));
  const clock = createFakeClock();
  db = migrate({
    dbPath: join(root, "state.db"),
    backupsDir: join(root, "backups"),
    sources: [KERNEL_MIGRATIONS, SETTINGS_MIGRATIONS],
    clock,
    logger: createLogger({ level: "error", clock, write: () => {} }),
  }).db;
  lines = [];
  settings = createSettingsModule({
    db,
    clock,
    logger: createLogger({ level: "warn", clock, write: (line) => lines.push(line) }),
    members: { capOf: () => null, ownerId: () => null, disabled: () => false },
  });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const ctx = { caller, connectionId: "c1", openSubscription: () => "s", closeSubscription: () => {} };
/** The owner's switch, written through the settings method the browser calls. */
const flip = (on: boolean, baseRevision: number) =>
  settings.rpc["settings.set"]({ key: "models", value: { modelsDevPricing: on }, baseRevision }, ctx);
const switchOn = () => flip(true, 0);

describe("models service: pricing is an opt-in (M7R138)", () => {
  it("answers forbidden with no models setting, and no helper ran", async () => {
    const { service, calls } = modelsBed(() => priced, undefined, settings.port);
    expect(await codeOf(service.pricing(caller, { modelId: "gpt-5" }))).toBe("forbidden");
    expect(calls).toHaveLength(0);
  });

  it("answers forbidden while the switch is stored off", async () => {
    await flip(false, 0);
    const { service, calls } = modelsBed(() => priced, undefined, settings.port);
    expect(await codeOf(service.pricing(caller, { modelId: "gpt-5" }))).toBe("forbidden");
    expect(calls).toHaveLength(0);
  });

  it("reads a damaged models row as off", async () => {
    db.run(
      "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ('u1', 'models', '{not json', 1, 0)",
    );
    const { service, calls } = modelsBed(() => priced, undefined, settings.port);
    expect(await codeOf(service.pricing(caller, { modelId: "gpt-5" }))).toBe("forbidden");
    expect(calls).toHaveLength(0);
  });

  it("looks up once after the switch is on, and serves the second call from the daemon cache", async () => {
    await switchOn();
    const { service, calls } = modelsBed(() => priced, undefined, settings.port);
    expect(await service.pricing(caller, { modelId: "gpt-5" })).toEqual(answer([gpt5]));
    expect(await service.pricing(caller, { modelId: "gpt-5" })).toEqual(answer([gpt5]));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "models.pricing", params: { modelId: "gpt-5" } });
    expect(calls[0]?.options.deadlineMs).toBe(45_000);
  });

  it("checks the switch before the cache: switching off ends the cached answers too", async () => {
    await switchOn();
    const { service, calls } = modelsBed(() => priced, undefined, settings.port);
    await service.pricing(caller, { modelId: "gpt-5" });
    await flip(false, 1);
    expect(await codeOf(service.pricing(caller, { modelId: "gpt-5" }))).toBe("forbidden");
    expect(calls).toHaveLength(1);
  });

  it("keeps one entry for one hour, then asks again", async () => {
    await switchOn();
    const { service, calls, clock } = modelsBed(() => priced, undefined, settings.port);
    await service.pricing(caller, { modelId: "gpt-5" });
    await clock.advance(PRICING_CACHE_MS - 1);
    await service.pricing(caller, { modelId: "gpt-5" });
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    await service.pricing(caller, { modelId: "gpt-5" });
    expect(calls).toHaveLength(2);
  });

  it("answers two different models within the hour from one download (MC34)", async () => {
    await switchOn();
    const { service, calls } = modelsBed(() => priced, undefined, settings.port);
    expect(await service.pricing(caller, { modelId: "gpt-5" })).toEqual(answer([gpt5]));
    expect(await service.pricing(caller, { modelId: "gpt-5-mini" })).toEqual(answer([mini]));
    expect(await service.pricing(caller, { provider: "openai", modelId: "gpt-5" })).toEqual(answer([gpt5]));
    expect(await service.pricing(caller, { modelId: "nothing" })).toEqual(answer([]));
    expect(calls).toHaveLength(1);
  });

  it("caches nothing when the helper sent no map, or the map is over 1 MiB serialised", async () => {
    await switchOn();
    const none = modelsBed(() => answer([gpt5]), undefined, settings.port);
    await none.service.pricing(caller, { modelId: "gpt-5" });
    await none.service.pricing(caller, { modelId: "gpt-5" });
    expect(none.calls).toHaveLength(2);
    const long = Array.from({ length: 4500 }, (_, i) => ({
      provider: "p",
      id: `${"x".repeat(250)}${i}`,
      input: 1,
    }));
    expect(Buffer.byteLength(JSON.stringify(long))).toBeGreaterThan(1024 * 1024);
    const big = modelsBed(() => ({ entries: [gpt5], catalog: long }), undefined, settings.port);
    expect(await big.service.pricing(caller, { modelId: "gpt-5" })).toEqual(answer([gpt5]));
    await big.service.pricing(caller, { modelId: "gpt-5" });
    expect(big.calls).toHaveLength(2);
  });

  it("does not cache a failure, and refuses a result with a field the contract does not name", async () => {
    await switchOn();
    let fail = true;
    const {
      service,
      calls,
      lines: logged,
    } = modelsBed(() => (fail ? new PapError("helper_failed") : priced), undefined, settings.port);
    expect(await codeOf(service.pricing(caller, { modelId: "gpt-5" }))).toBe("helper_failed");
    fail = false;
    expect(await service.pricing(caller, { modelId: "gpt-5" })).toEqual(answer([gpt5]));
    expect(calls).toHaveLength(2);
    const leaky = modelsBed(
      () => ({ entries: [{ provider: "p", id: "m", name: "sk-LEAK" }] }),
      undefined,
      settings.port,
    );
    expect(await codeOf(leaky.service.pricing(caller, { modelId: "m" }))).toBe("helper_failed");
    expect(JSON.stringify([logged, leaky.lines])).not.toContain("sk-LEAK");
  });
});
