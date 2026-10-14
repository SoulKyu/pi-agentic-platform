import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import type { HelperContext } from "../ops.ts";
import { login, logout, setApiKey } from "./auth.ts";

const PROVIDER = "scripted-auth";
const BOM = String.fromCharCode(0xfeff);
let bed: ModelsBed;
let authPath: string;

beforeEach(async () => {
  bed = await makeModelsBed();
  authPath = join(bed.agentDir, "auth.json");
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PAP_TEST_PROVIDER", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.cleanup();
});

interface Talk {
  readonly events: unknown[];
  readonly prompts: unknown[];
  readonly ctx: HelperContext;
}
/** A context whose prompt answers from `answers` in order (`null` = the person declined). */
function talk(answers: Array<string | null>, signal = new AbortController().signal): Talk {
  const events: unknown[] = [];
  const prompts: unknown[] = [];
  const queue = [...answers];
  const ctx: HelperContext = {
    ...bed.context(),
    signal,
    emit: (event) => void events.push(event),
    prompt: async (prompt) => {
      prompts.push(prompt);
      return queue.shift() ?? null;
    },
  };
  return { events, prompts, ctx };
}
const failureOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
const readAuth = async () => JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
const modeOf = async (path: string) => (await fs.stat(path)).mode & 0o777;
const exists = (path: string) =>
  fs.stat(path).then(
    () => true,
    () => false,
  );

describe("auth.login oauth (scripted provider)", () => {
  it("emits the auth link, asks for the manual code, and stores an OAuth credential at mode 0600", async () => {
    const { events, prompts, ctx } = talk(["CODE-123"]);
    expect(await login.run({ provider: PROVIDER, method: "oauth" }, ctx)).toEqual({ ok: true });
    expect(events[0]).toEqual({
      kind: "auth_url",
      url: "https://auth.scripted.test/authorize?state=scripted",
      instructions: "Open the link, sign in, then paste the code.",
    });
    expect(prompts).toEqual([{ type: "manual_code", message: "Paste the code" }]);
    const stored = (await readAuth())[PROVIDER] as Record<string, unknown>;
    expect(stored).toMatchObject({ type: "oauth", access: "access-CODE-123", refresh: "refresh-CODE-123" });
    expect(await modeOf(authPath)).toBe(0o600);
  });

  it("ends failed when the prompt is declined, and leaves auth.json byte for byte as it was", async () => {
    const before = JSON.stringify({ cerebras: { type: "api_key", key: "sk-other" } }, null, 2);
    await fs.writeFile(authPath, before, { mode: 0o600 });
    const { ctx } = talk([null]);
    expect(await failureOf(login.run({ provider: PROVIDER, method: "oauth" }, ctx))).toMatchObject({
      code: "failed",
    });
    expect(await fs.readFile(authPath, "utf8")).toBe(before);
  });

  it("does not create auth.json when the flow is declined", async () => {
    const { ctx } = talk([null]);
    await failureOf(login.run({ provider: PROVIDER, method: "oauth" }, ctx));
    expect(await exists(authPath)).toBe(false);
  });

  it("stops when the run is cancelled while a prompt is open", async () => {
    const controller = new AbortController();
    const { ctx } = talk([], controller.signal);
    const waiting = new Promise<string | null>(() => {});
    const run = login.run({ provider: PROVIDER, method: "oauth" }, { ...ctx, prompt: () => waiting });
    controller.abort();
    expect(await failureOf(run)).toMatchObject({ code: "failed" });
    expect(await exists(authPath)).toBe(false);
  });

  it("answers not_found for an unknown provider and bad_params for a method the provider lacks", async () => {
    const { ctx } = talk([]);
    expect(await failureOf(login.run({ provider: "nobody", method: "oauth" }, ctx))).toMatchObject({
      code: "not_found",
    });
    expect(await failureOf(login.run({ provider: "cerebras", method: "oauth" }, ctx))).toMatchObject({
      code: "bad_params",
    });
  });
});

describe("auth.login api_key", () => {
  it("stores the key the secret prompt returned, and puts nothing of it in an event", async () => {
    const { events, prompts, ctx } = talk(["sk-FROM-THE-PROMPT"]);
    expect(await login.run({ provider: "cerebras", method: "api_key" }, ctx)).toEqual({ ok: true });
    expect(prompts).toHaveLength(1);
    expect(await readAuth()).toEqual({ cerebras: { type: "api_key", key: "sk-FROM-THE-PROMPT" } });
    expect(JSON.stringify([events, prompts])).not.toContain("sk-FROM-THE-PROMPT");
  });

  it("refuses an answer that is a command and stores nothing", async () => {
    const touched = join(bed.root, "ran-login");
    const { ctx } = talk([`!touch ${touched}`]);
    expect(await failureOf(login.run({ provider: "cerebras", method: "api_key" }, ctx))).toMatchObject({
      code: "bad_params",
    });
    expect(await exists(authPath)).toBe(false);
    expect(await exists(touched)).toBe(false);
  });
});

describe("auth.setApiKey", () => {
  it("writes { type: api_key, key } through the provider's own login, at mode 0600", async () => {
    const { prompts, ctx } = talk([]);
    expect(await setApiKey.run({ provider: "cerebras", key: "sk-cerebras-1" }, ctx)).toEqual({ ok: true });
    expect(await readAuth()).toEqual({ cerebras: { type: "api_key", key: "sk-cerebras-1" } });
    expect(await modeOf(authPath)).toBe(0o600);
    expect(prompts).toEqual([]);
  });

  it("keeps the other providers' entries exactly as they were", async () => {
    const other = { type: "oauth", access: "a", refresh: "r", expires: 1, extra: { nested: true } };
    await fs.writeFile(authPath, JSON.stringify({ zed: other, cerebras: { type: "api_key", key: "old" } }));
    await setApiKey.run({ provider: "cerebras", key: "new" }, talk([]).ctx);
    expect(await readAuth()).toEqual({ zed: other, cerebras: { type: "api_key", key: "new" } });
  });

  it("tightens a looser mode to 0600", async () => {
    await fs.writeFile(authPath, "{}", { mode: 0o644 });
    await fs.chmod(authPath, 0o644);
    await setApiKey.run({ provider: "cerebras", key: "k" }, talk([]).ctx);
    expect(await modeOf(authPath)).toBe(0o600);
  });

  it("cancels a provider whose key login asks for something else, and says so", async () => {
    const { ctx } = talk([]);
    expect(await failureOf(setApiKey.run({ provider: PROVIDER, key: "k" }, ctx))).toMatchObject({
      code: "bad_params",
    });
  });

  it("refuses a key that is a command, even when the schema was bypassed", async () => {
    const touched = join(bed.root, "ran-set");
    const failure = await failureOf(
      setApiKey.run({ provider: "cerebras", key: `!touch ${touched}` }, talk([]).ctx),
    );
    expect(failure).toMatchObject({ code: "bad_params" });
    expect(await exists(authPath)).toBe(false);
    expect(await exists(touched)).toBe(false);
  });

  it("never puts the key in a failure", async () => {
    await fs.writeFile(authPath, "{ not json");
    const failure = (await failureOf(
      setApiKey.run({ provider: "cerebras", key: "sk-SECRET-IN-FAILURE" }, talk([]).ctx),
    )) as Error;
    expect(failure).toMatchObject({ code: "config_invalid" });
    expect(`${failure.name} ${failure.message} ${failure.stack}`).not.toContain("sk-SECRET-IN-FAILURE");
    expect(await fs.readFile(authPath, "utf8")).toBe("{ not json");
  });
});

describe("auth.logout", () => {
  it("removes only that provider's credential and keeps the mode", async () => {
    await fs.writeFile(
      authPath,
      JSON.stringify({ cerebras: { type: "api_key", key: "k" }, keep: { type: "api_key", key: "z" } }),
      { mode: 0o600 },
    );
    expect(await logout.run({ provider: "cerebras" }, talk([]).ctx)).toEqual({ ok: true });
    expect(await readAuth()).toEqual({ keep: { type: "api_key", key: "z" } });
    expect(await modeOf(authPath)).toBe(0o600);
  });

  it("removes a credential whose provider is no longer known, and answers not_found when there is none", async () => {
    await fs.writeFile(authPath, JSON.stringify({ gone: { type: "api_key", key: "k" } }));
    expect(await logout.run({ provider: "gone" }, talk([]).ctx)).toEqual({ ok: true });
    expect(await readAuth()).toEqual({});
    expect(await failureOf(logout.run({ provider: "gone" }, talk([]).ctx))).toMatchObject({
      code: "not_found",
    });
  });

  it("is quiet for a provider that holds nothing, and does not create auth.json", async () => {
    expect(await logout.run({ provider: "cerebras" }, talk([]).ctx)).toEqual({ ok: true });
    expect(await exists(authPath)).toBe(false);
  });
});

describe("the Pi file boundary", () => {
  it("refuses to write a hard-linked auth.json with its own code, and changes neither name", async () => {
    const twin = join(bed.agentDir, "auth.twin");
    const text = JSON.stringify({ cerebras: { type: "api_key", key: "old" } });
    await fs.writeFile(authPath, text, { mode: 0o600 });
    await fs.link(authPath, twin);
    const failure = await failureOf(setApiKey.run({ provider: "cerebras", key: "k" }, talk([]).ctx));
    expect(failure).toMatchObject({ code: "config_hard_link", message: "hard-link" });
    expect(await fs.readFile(authPath, "utf8")).toBe(text);
    expect(await fs.readFile(twin, "utf8")).toBe(text);
    expect(await failureOf(logout.run({ provider: "cerebras" }, talk([]).ctx))).toMatchObject({
      code: "config_hard_link",
    });
    expect(await fs.readFile(twin, "utf8")).toBe(text);
  });

  it("refuses an auth.json that is a link out of the home folder, and writes nothing there", async () => {
    const outside = join(bed.root, "outside.json");
    await fs.writeFile(outside, "{}");
    await fs.symlink(outside, authPath);
    expect(await failureOf(setApiKey.run({ provider: "cerebras", key: "k" }, talk([]).ctx))).toMatchObject({
      code: "config_path_refused",
    });
    expect(await fs.readFile(outside, "utf8")).toBe("{}");
  });

  it("refuses a dangling link", async () => {
    await fs.symlink(join(bed.root, "nowhere.json"), authPath);
    expect(await failureOf(setApiKey.run({ provider: "cerebras", key: "k" }, talk([]).ctx))).toMatchObject({
      code: "config_path_refused",
      message: "link-dangling",
    });
  });

  it.each([["not json"], ["[]"], ['{"cerebras":'], ["null"]])(
    "answers config_invalid for an auth.json holding %s and leaves it alone",
    async (text) => {
      await fs.writeFile(authPath, text);
      expect(await failureOf(setApiKey.run({ provider: "cerebras", key: "k" }, talk([]).ctx))).toMatchObject({
        code: "config_invalid",
      });
      expect(await fs.readFile(authPath, "utf8")).toBe(text);
    },
  );

  it("reads a file that starts with a byte order mark, as Pi does", async () => {
    await fs.writeFile(authPath, `${BOM}${JSON.stringify({ keep: { type: "api_key", key: "z" } })}`);
    await setApiKey.run({ provider: "cerebras", key: "k" }, talk([]).ctx);
    expect(await readAuth()).toEqual({
      keep: { type: "api_key", key: "z" },
      cerebras: { type: "api_key", key: "k" },
    });
  });
});

describe("a command value is never run (MC24, owner c3)", () => {
  it("by sign-in, key or sign-out, whichever provider holds it", async () => {
    const marker = (name: string) => join(bed.root, `ran-${name}`);
    await fs.writeFile(
      authPath,
      JSON.stringify({
        anthropic: { type: "api_key", key: `!touch ${marker("other-key")}` },
        openai: { type: "api_key", env: { OPENAI_ORG: `!touch ${marker("other-env")}` } },
        cerebras: { type: "api_key", key: `!touch ${marker("same-key")}` },
        groq: { type: "api_key", key: `!touch ${marker("gone-key")}` },
      }),
    );
    await setApiKey.run({ provider: "cerebras", key: "sk-new" }, talk([]).ctx);
    await login.run({ provider: PROVIDER, method: "oauth" }, talk(["CODE"]).ctx);
    await logout.run({ provider: "groq" }, talk([]).ctx);
    for (const name of ["other-key", "other-env", "same-key", "gone-key"])
      expect(await exists(marker(name)), name).toBe(false);
    expect(await readAuth()).toMatchObject({
      anthropic: { key: `!touch ${marker("other-key")}` },
      cerebras: { type: "api_key", key: "sk-new" },
    });
  });
});

describe("a command in models.json is not run either (MC24)", () => {
  it("when the owner stores a key for that provider, or signs out of it", async () => {
    const key = join(bed.root, "ran-models-key");
    const header = join(bed.root, "ran-models-header");
    await bed.write(join(bed.agentDir, "models.json"), {
      providers: {
        mine: {
          baseUrl: "http://localhost:1/v1",
          apiKey: `!touch ${key}`,
          headers: { "X-A": `!touch ${header}` },
          api: "openai-completions",
          models: [{ id: "m1" }],
        },
      },
    });
    expect(await setApiKey.run({ provider: "mine", key: "sk-mine" }, talk([]).ctx)).toEqual({ ok: true });
    expect(await logout.run({ provider: "mine" }, talk([]).ctx)).toEqual({ ok: true });
    expect(await exists(key)).toBe(false);
    expect(await exists(header)).toBe(false);
  });
});

describe("a credential Pi committed is a success even when its model sync fails (MC31)", () => {
  // Real Pi: this models.json makes the follow-up sync throw CredentialSynchronizationError after the write.
  const breakModels = () => bed.write(join(bed.agentDir, "models.json"), { providers: { cerebras: {} } });

  it("setApiKey, login and logout answer ok and leave auth.json as Pi committed it", async () => {
    await breakModels();
    expect(await setApiKey.run({ provider: "cerebras", key: "sk-probe-1" }, talk([]).ctx)).toEqual({
      ok: true,
    });
    expect(await readAuth()).toEqual({ cerebras: { type: "api_key", key: "sk-probe-1" } });
    expect(await logout.run({ provider: "cerebras" }, talk([]).ctx)).toEqual({ ok: true });
    expect(await readAuth()).toEqual({});
    expect(await login.run({ provider: "cerebras", method: "api_key" }, talk(["sk-probe-2"]).ctx)).toEqual({
      ok: true,
    });
    expect(await readAuth()).toEqual({ cerebras: { type: "api_key", key: "sk-probe-2" } });
  });

  it("still fails when the write itself failed", async () => {
    await breakModels();
    await fs.writeFile(authPath, "{ not json");
    expect(await failureOf(setApiKey.run({ provider: "cerebras", key: "k" }, talk([]).ctx))).toMatchObject({
      code: "config_invalid",
    });
  });
});

describe("two sign-ins at once", () => {
  it("keep both credentials", async () => {
    await Promise.all([
      setApiKey.run({ provider: "cerebras", key: "k1" }, talk([]).ctx),
      setApiKey.run({ provider: "groq", key: "k2" }, talk([]).ctx),
      login.run({ provider: PROVIDER, method: "oauth" }, talk(["C"]).ctx),
    ]);
    const stored = await readAuth();
    expect(Object.keys(stored).sort()).toEqual(["cerebras", "groq", PROVIDER]);
  });

  it("wait for a lock held by another process, and break one that went stale", async () => {
    const lock = `${authPath}.lock`;
    await fs.mkdir(lock);
    const run = setApiKey.run({ provider: "cerebras", key: "k" }, talk([]).ctx);
    await fs.rmdir(lock);
    await run;
    expect(await readAuth()).toEqual({ cerebras: { type: "api_key", key: "k" } });
    expect(await exists(lock)).toBe(false);

    await fs.mkdir(lock);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lock, old, old);
    await setApiKey.run({ provider: "groq", key: "k2" }, talk([]).ctx);
    expect(Object.keys(await readAuth()).sort()).toEqual(["cerebras", "groq"]);
    expect(await exists(lock)).toBe(false);
  });
});
