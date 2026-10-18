import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createHelperPool, type HelperPool } from "../../kernel/helper/pool.ts";
import { type LogFields, type Logger, silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createModelsService } from "./index.ts";
import { signInDeps } from "./testing/bed.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/helper/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
// pi-claude-bridge's registration rule: the first instance in a process registers at load, a later one never does in a
// helper (it waits for `session_start`). The pi-host unit test "extensions.once-per-process" is its control.
const BRIDGE_LIKE = join(REPO, "packages/pi-host/src/testing/bridge-like-extension.mjs");
const EXEC_ARGV = [
  "--conditions=development",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];

let root: string;
let agentDir: string;
let pool: HelperPool;
let logs: Array<{ msg: string; fields: LogFields | undefined }>;
const logger: Logger = { ...silentLogger, warn: (msg, fields) => void logs.push({ msg, fields }) };

const service = () =>
  createModelsService({ helpers: pool, projects: { covers: () => false }, logger, ...signInDeps });
const listed = async () =>
  (await service().extensions()).providers.map((provider) => ({
    id: provider.id,
    models: provider.models.map((model) => [model.id, model.offered]),
  }));
const settings = (value: object) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(value));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-models-ext-int-")));
  agentDir = join(root, "home", ".pi", "agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(root, "pap"));
  copyFileSync(BRIDGE_LIKE, join(agentDir, "extensions", "pap-test-bridge.js"));
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

describe("models.extensions through a real helper", () => {
  it("two reads in a row both list a provider that registers once per process: no helper is reused", async () => {
    const bridge = { id: "pap-test-bridge", models: [["bridge-one", true]] };
    expect(await listed()).toEqual([bridge]);
    expect(await listed()).toEqual([bridge]);
  });

  it("keeps nothing: a read after the extension is gone lists nothing", async () => {
    expect((await listed()).map((provider) => provider.id)).toEqual(["pap-test-bridge"]);
    rmSync(join(agentDir, "extensions", "pap-test-bridge.js"));
    expect(await listed()).toEqual([]);
  });

  it("switches an extension's model into My selection through models.setEnabled, then Clean up keeps it", async () => {
    settings({ enabledModels: ["anthropic/claude-sonnet-4-5", "anthropic/nothing-here"] });
    const caller = testCaller();
    const models = service();
    expect(
      await models.setEnabled(caller, {
        op: { op: "provider", provider: "pap-test-bridge", enabled: true },
      }),
    ).toEqual({
      patterns: ["anthropic/claude-sonnet-4-5", "anthropic/nothing-here", "pap-test-bridge/bridge-one"],
    });
    expect(await listed()).toEqual([{ id: "pap-test-bridge", models: [["bridge-one", true]] }]);
    // Clean up drops the entry of a provider it knows and keeps the extension's, which it cannot judge here.
    expect(await models.setEnabled(caller, { op: { op: "prune" } })).toEqual({
      patterns: ["anthropic/claude-sonnet-4-5", "pap-test-bridge/bridge-one"],
    });
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).enabledModels).toEqual([
      "anthropic/claude-sonnet-4-5",
      "pap-test-bridge/bridge-one",
    ]);
  });

  it("marks a model outside the global selection as not offered, and one a pattern names as offered", async () => {
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          mine: {
            baseUrl: "http://localhost:1/v1",
            apiKey: "local-no-key",
            api: "openai-completions",
            models: [{ id: "m1" }],
          },
        },
      }),
    );
    settings({ enabledModels: ["mine/m1"] });
    expect(await listed()).toEqual([{ id: "pap-test-bridge", models: [["bridge-one", false]] }]);
    settings({ enabledModels: ["mine/m1", "pap-test-bridge/*"] });
    expect(await listed()).toEqual([{ id: "pap-test-bridge", models: [["bridge-one", true]] }]);
  });
});
