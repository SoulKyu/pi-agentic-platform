import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { PapError } from "@pap/contracts";
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
const EXEC_ARGV = [
  "--conditions=development",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];
const SECRET = "sk-LITERAL-SECRET-FROM-MODELS-JSON";

let root: string;
let agentDir: string;
let project: string;
let pool: HelperPool;
let logs: Array<{ msg: string; fields: LogFields | undefined }>;
const logger: Logger = { ...silentLogger, warn: (msg, fields) => void logs.push({ msg, fields }) };
const caller = testCaller();

const service = () =>
  createModelsService({
    helpers: pool,
    projects: { covers: (_owner, cwd) => cwd.startsWith(project) },
    logger,
    ...signInDeps,
  });
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-models-int-")));
  agentDir = join(root, "home", ".pi", "agent");
  project = join(root, "home", "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(root, "pap"));
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mine: {
          name: "Mine",
          baseUrl: "http://localhost:1/v1",
          apiKey: SECRET,
          api: "openai-completions",
          models: [{ id: "m1" }, { id: "m2" }],
        },
      },
    }),
  );
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

describe("models through a real helper", () => {
  it("lists the providers of a temporary agent directory without a key, offline", async () => {
    const overview = await service().overview(caller);
    expect(overview.offline).toBe(true);
    expect(overview.providers.find((p) => p.id === "mine")).toMatchObject({
      origin: "models.json",
      auth: { apiKey: true, configured: true, stored: null },
    });
    expect(JSON.stringify(overview)).not.toContain(SECRET);
    expect(overview.providers.find((p) => p.id === "anthropic")?.origin).toBe("builtin");
  });

  it("writes the default model, and answers bad_request outside the enabled scope", async () => {
    await service().setDefault(caller, { provider: "mine", modelId: "m2" });
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      defaultProvider: "mine",
      defaultModel: "m2",
    });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["anthropic/*"] }));
    expect(await codeOf(service().setDefault(caller, { provider: "mine", modelId: "m1" }))).toBe(
      "bad_request",
    );
    expect(await codeOf(service().setDefault(caller, { provider: "mine", modelId: "nope" }))).toBe(
      "not_found",
    );
  });

  it("keeps both edits of two overlapping setEnabled calls (real helpers, pool of 2)", async () => {
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          mine: {
            baseUrl: "http://localhost:1/v1",
            apiKey: SECRET,
            api: "openai-completions",
            models: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
          },
        },
      }),
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["mine/*"] }));
    const models = service();
    await Promise.all(
      ["m1", "m2"].map((modelId) =>
        models.setEnabled(caller, { op: { op: "toggle", provider: "mine", modelId, enabled: false } }),
      ),
    );
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      enabledModels: ["mine/m3"],
    });
  });

  it("answers project_scope for a trusted project that sets the default itself", async () => {
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    new ProjectTrustStore(agentDir).set(project, true);
    expect(await codeOf(service().setDefaultThinking(caller, { level: "high", cwd: project }))).toBe(
      "project_scope",
    );
    expect(await codeOf(service().setDefaultThinking(caller, { level: "high", cwd: "/etc" }))).toBe(
      "invalid_cwd",
    );
  });

  it("answers a refresh offline when PI_OFFLINE is set, with no request", async () => {
    expect(await service().refreshCatalog()).toEqual({ changed: false, offline: true, failedProviders: [] });
  });

  it("answers config_path_refused for a models.json that is a link outside the home folder", async () => {
    const outside = join(root, "outside.json");
    writeFileSync(outside, "{}");
    rmSync(join(agentDir, "models.json"));
    symlinkSync(outside, join(agentDir, "models.json"));
    expect(await codeOf(service().overview(caller))).toBe("config_path_refused");
  });
});

describe("the models.json editor through a real helper", () => {
  const confirmed = () => testCaller({ stepUpUntil: signInDeps.clock.now() + 60_000 });
  const file = () => join(agentDir, "models.json");
  let models: ReturnType<typeof service>;
  beforeEach(() => {
    models = service();
  });

  it("shows the file masked and saves an edit around the key without losing it", async () => {
    const view = await models.configGet();
    expect(view.path).toBe(file());
    expect(view.text).toContain("<redacted:0>");
    expect(view.issues).toEqual([]);
    // the revision is no plain hash of the file (MC32), and stays the same within one boot
    expect(view.revision).not.toBe(createHash("sha256").update(readFileSync(file(), "utf8")).digest("hex"));
    expect((await models.configGet()).revision).toBe(view.revision);
    expect((await service().configGet()).revision).not.toBe(view.revision);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const result = await models.configSave(confirmed(), {
      text: (view.text ?? "").replace('"m2"', '"m3"'),
      baseRevision: view.revision,
    });
    expect(result).toMatchObject({ enabledModelsSynced: true });
    const written = readFileSync(file(), "utf8");
    expect(written).toContain(SECRET);
    expect(written).toContain('"m3"');
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("asks for the step-up, answers conflict for an old revision, and refuses content with paths only", async () => {
    const view = await models.configGet();
    const text = view.text ?? "";
    expect(await codeOf(models.configSave(caller, { text, baseRevision: view.revision }))).toBe(
      "step_up_required",
    );
    expect(await codeOf(models.configSave(confirmed(), { text, baseRevision: "0".repeat(64) }))).toBe(
      "conflict",
    );
    const refusal = await models.configSave(confirmed(), {
      text: `{"providers": {"mine": {"models": "x", "apiKey": "sk-TYPED"}}}`,
      baseRevision: view.revision,
    });
    expect(refusal).toEqual({ code: "config_invalid", issues: ["$.providers.mine.models"] });
    expect(readFileSync(file(), "utf8")).toContain(SECRET);
  });

  it("answers config_hard_link for a file with another name, and writes nothing", async () => {
    linkSync(file(), join(agentDir, "models.copy.json"));
    const view = await models.configGet();
    expect(
      await codeOf(models.configSave(confirmed(), { text: view.text ?? "", baseRevision: view.revision })),
    ).toBe("config_hard_link");
    expect(readFileSync(join(agentDir, "models.copy.json"), "utf8")).toContain(SECRET);
  });
});

describe("provider discover, test and pricing through a real helper", () => {
  const confirmed = () => testCaller({ stepUpUntil: signInDeps.clock.now() + 60_000 });
  const pricingOn = () =>
    createModelsService({
      helpers: pool,
      projects: { covers: () => true },
      logger,
      ...signInDeps,
      settings: { models: () => ({ modelsDevPricing: true }) },
    });

  it("discover and test answer network when the provider cannot be reached, with no key in the answer", async () => {
    const discovered = await service().discover(confirmed(), { provider: "mine" });
    expect(discovered).toEqual({ models: [], code: "network" });
    const tested = await service().test(caller, { provider: "mine", modelId: "m1" });
    expect(tested).toMatchObject({ ok: false, code: "network" });
    expect(JSON.stringify([discovered, tested, logs])).not.toContain(SECRET);
  });

  it("answers forbidden with the switch off, and helper_failed with it on when models.dev cannot be reached", async () => {
    expect(await codeOf(service().pricing(caller, { modelId: "gpt-5" }))).toBe("forbidden");
    // No network in tests (the guard is on, and its line is checked in the pool tests): the failure carries no text.
    expect(await codeOf(pricingOn().pricing(caller, { modelId: "gpt-5" }))).toBe("helper_failed");
  });
});
