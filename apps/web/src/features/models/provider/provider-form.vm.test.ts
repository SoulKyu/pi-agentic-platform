import { BASE_URL_TABLE, HTTP_PLAINTEXT_POLICY, ProviderInput } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { settingsProvidersEn, settingsProvidersFr } from "../../../i18n/catalog/settings-providers.ts";
import { PRESETS } from "./presets.ts";
import {
  carriesSecret,
  draftOf,
  emptyDraft,
  emptyHeader,
  emptyModel,
  issueTargets,
  PROBLEM_KEYS,
  problems,
  slug,
  toInput,
  type Draft,
} from "./provider-form.vm.ts";

const none = new Set<string>();
const keysOf = (draft: Draft, existing: ReadonlySet<string> = none, builtin: ReadonlySet<string> = none) =>
  problems(draft, existing, builtin).map((problem) => problem.key);
const valid = (over: Partial<Draft> = {}): Draft => ({
  ...emptyDraft(),
  id: "mine",
  baseUrl: "https://api.example.com/v1",
  models: [{ ...emptyModel(), id: "m1" }],
  ...over,
});

describe("presets", () => {
  it("are the eight starters of owner q2, with the exact URLs and auth", () => {
    expect(PRESETS.map((preset) => [preset.key, preset.api, preset.baseUrl, preset.auth])).toEqual([
      ["ollama", "openai-completions", "http://localhost:11434/v1", "none"],
      ["lmstudio", "openai-completions", "http://localhost:1234/v1", "none"],
      ["vllm", "openai-completions", "http://localhost:8000/v1", "none"],
      ["openrouter", "openai-completions", "https://openrouter.ai/api/v1", "stored"],
      ["openai-compatible", "openai-completions", "", "stored"],
      ["anthropic-compatible", "anthropic-messages", "", "stored"],
      ["gemini-compatible", "google-generative-ai", "", "stored"],
      ["custom", "openai-completions", "", "stored"],
    ]);
  });

  it.each(PRESETS.map((preset) => [preset.key, preset] as const))(
    "toInput of %s with a model added is accepted by ProviderInput",
    (_key, preset) => {
      const draft = emptyDraft(preset);
      const filled: Draft = {
        ...draft,
        id: draft.id || "mine",
        baseUrl: draft.baseUrl || "https://api.example.com/v1",
        models: [{ ...emptyModel(), id: "m1" }],
      };
      expect(ProviderInput.safeParse(toInput(filled)).success).toBe(true);
      expect(problems(filled, none, none)).toEqual([]);
    },
  );

  it("a local preset fills the auth with none and a hosted one with stored", () => {
    expect(emptyDraft(PRESETS[0]).auth).toEqual({ kind: "none" });
    expect(emptyDraft(PRESETS[3]).auth).toEqual({ kind: "stored" });
    expect(emptyDraft().auth).toEqual({ kind: "stored" });
  });
});

describe("problems", () => {
  it("baseUrl.host for a LAN http: server, read from BASE_URL_TABLE's shipped column", () => {
    const row = BASE_URL_TABLE.find(([url]) => url === "http://192.168.1.50:11434/v1");
    const shipped = HTTP_PLAINTEXT_POLICY === "loopback" ? row?.[1] : row?.[2];
    const keys = keysOf(valid({ baseUrl: "http://192.168.1.50:11434/v1" }));
    expect(keys.includes("baseUrl.host")).toBe(shipped === "host");
    expect(keysOf(valid({ baseUrl: "http://192.168.1.50:11434" })).includes("baseUrl.host")).toBe(
      HTTP_PLAINTEXT_POLICY === "loopback",
    );
  });

  it("maps every refusal of the table to a key of its own, in both columns of the policy", () => {
    for (const [url, loopback, any] of BASE_URL_TABLE) {
      const verdict = HTTP_PLAINTEXT_POLICY === "loopback" ? loopback : any;
      const found = keysOf(valid({ baseUrl: url })).filter((key) => key.startsWith("baseUrl."));
      expect(found.length === 0, url).toBe(verdict === "ok");
    }
  });

  it("baseUrl.credentials for user:pw@", () => {
    expect(keysOf(valid({ baseUrl: "https://user:pw@api.example.com" }))).toContain("baseUrl.credentials");
  });

  it("id.builtin for anthropic, id.exists on create, id.format and id.required", () => {
    expect(keysOf(valid({ id: "anthropic" }), none, new Set(["anthropic"]))).toContain("id.builtin");
    expect(keysOf(valid({ id: "mine" }), new Set(["mine"]))).toContain("id.exists");
    expect(keysOf(valid({ id: "Mine" }))).toContain("id.format");
    expect(keysOf(valid({ id: "" }))).toContain("id.required");
    expect(keysOf(valid())).toEqual([]);
  });

  it("models.limit at 501 rows, not at 500", () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...emptyModel(), id: `m${index}` }));
    expect(keysOf(valid({ models: rows(501) }))).toContain("models.limit");
    expect(keysOf(valid({ models: rows(500) }))).toEqual([]);
  });

  it("models: an empty id, a duplicate id and a context window that is not a whole number", () => {
    expect(keysOf(valid({ models: [emptyModel()] }))).toContain("models.idRequired");
    const model = { ...emptyModel(), id: "m1" };
    expect(keysOf(valid({ models: [model, model] }))).toContain("models.duplicate");
    expect(keysOf(valid({ models: [{ ...model, contextWindow: "12.5" }] }))).toContain("models.number");
    expect(keysOf(valid({ models: [{ ...model, contextWindow: "128000", maxTokens: "4096" }] }))).toEqual([]);
  });

  it("headers.credential for a literal X-Api-Key, headers.dollar for a literal with $, headers.bang", () => {
    const header = (name: string, text: string) => ({
      ...emptyHeader(),
      name,
      value: { kind: "literal" as const, text },
    });
    expect(keysOf(valid({ headers: [header("X-Api-Key", "abc")] }))).toContain("headers.credential");
    expect(keysOf(valid({ headers: [header("X-Team", "a$b")] }))).toContain("headers.dollar");
    expect(keysOf(valid({ headers: [header("X-Team", "!ls")] }))).toContain("headers.bang");
    expect(keysOf(valid({ headers: [header("X-Team", "red")] }))).toEqual([]);
  });

  it("an env header is fine for a credential name; a bad variable name is headers.envName", () => {
    const env = (name: string, variable: string) => ({
      ...emptyHeader(),
      name,
      value: { kind: "env" as const, name: variable },
    });
    expect(keysOf(valid({ headers: [env("X-Api-Key", "TEAM_KEY")] }))).toEqual([]);
    expect(keysOf(valid({ headers: [env("X-Api-Key", "$TEAM_KEY")] }))).toContain("headers.envName");
  });

  it("headers: a banned or duplicate name, and the cap of eight", () => {
    const row = (name: string) => ({
      ...emptyHeader(),
      name,
      value: { kind: "literal" as const, text: "v" },
    });
    expect(keysOf(valid({ headers: [row("Host")] }))).toContain("headers.name");
    expect(keysOf(valid({ headers: [row("X-A"), row("x-a")] }))).toContain("headers.duplicate");
    expect(keysOf(valid({ headers: Array.from({ length: 9 }, (_, index) => row(`X-H${index}`)) }))).toContain(
      "headers.limit",
    );
  });

  it("a kept header and a kept auth raise nothing", () => {
    const kept = { ...emptyHeader(), name: "X-Org", value: { kind: "keep" as const } };
    expect(keysOf(valid({ headers: [kept], auth: { kind: "keep" } }))).toEqual([]);
  });

  it("an env auth needs a valid variable name", () => {
    expect(keysOf(valid({ auth: { kind: "env", name: "" } }))).toContain("auth.envName");
    expect(keysOf(valid({ auth: { kind: "env", name: "OPENAI_API_KEY" } }))).toEqual([]);
  });

  it("every key has an English and a French message, and every message key is used", () => {
    for (const key of PROBLEM_KEYS) {
      const id = `settingsProviders.problem.${key}` as keyof typeof settingsProvidersEn;
      expect(settingsProvidersEn[id], key).toBeTruthy();
      expect(settingsProvidersFr[id], key).toBeTruthy();
    }
    const prefixed = Object.keys(settingsProvidersEn).filter((id) =>
      id.startsWith("settingsProviders.problem."),
    );
    expect(prefixed.map((id) => id.slice("settingsProviders.problem.".length)).sort()).toEqual(
      [...PROBLEM_KEYS].sort(),
    );
  });
});

describe("toInput and draftOf", () => {
  it("sends the exact object: trimmed, no key, optional fields omitted", () => {
    const draft = valid({
      id: " mine ",
      name: " Mine ",
      baseUrl: " https://api.example.com/v1 ",
      auth: { kind: "env", name: "MINE_KEY" },
      headers: [{ name: "X-Team", value: { kind: "env", name: "TEAM" } }],
      models: [
        { ...emptyModel(), id: "m1", name: "", reasoning: true, image: true, contextWindow: "1000" },
        { ...emptyModel(), id: "m2" },
      ],
    });
    expect(toInput(draft)).toEqual({
      id: "mine",
      name: "Mine",
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      auth: { kind: "env", name: "MINE_KEY" },
      headers: [{ name: "X-Team", value: { kind: "env", name: "TEAM" } }],
      models: [{ id: "m1", reasoning: true, input: ["text", "image"], contextWindow: 1000 }, { id: "m2" }],
    });
    expect(JSON.stringify(toInput(draft))).not.toMatch(/apiKey|"key"/);
  });

  it("draftOf reads a provider back, kept values stay kept", () => {
    const provider = ProviderInput.parse({
      id: "mine",
      name: "Mine",
      api: "anthropic-messages",
      baseUrl: "https://api.example.com",
      auth: { kind: "keep" },
      headers: [{ name: "X-Org", value: { kind: "keep" } }],
      models: [{ id: "m1", input: ["text", "image"], maxTokens: 99 }],
    });
    const draft = draftOf(provider);
    expect(draft.auth).toEqual({ kind: "keep" });
    expect(draft.headers[0]?.value).toEqual({ kind: "keep" });
    expect(draft.models[0]).toMatchObject({ id: "m1", image: true, maxTokens: "99", contextWindow: "" });
    expect(toInput(draft)).toEqual(provider);
  });

  it("carriesSecret: stored or env auth, or any env header", () => {
    expect(carriesSecret(valid({ auth: { kind: "none" } }))).toBe(false);
    expect(carriesSecret(valid({ auth: { kind: "stored" } }))).toBe(true);
    expect(carriesSecret(valid({ auth: { kind: "env", name: "K" } }))).toBe(true);
    expect(
      carriesSecret(
        valid({
          auth: { kind: "none" },
          headers: [{ name: "X-A", value: { kind: "env", name: "A" } }],
        }),
      ),
    ).toBe(true);
    expect(
      carriesSecret(
        valid({
          auth: { kind: "none" },
          headers: [{ name: "X-A", value: { kind: "literal", text: "a" } }],
        }),
      ),
    ).toBe(false);
  });
});

describe("issueTargets and slug", () => {
  it("maps the helper's config_invalid paths to fields, rows and fixed sentences", () => {
    const targets = issueTargets([
      "$.provider.id",
      "$.provider.headers[2]",
      "$.provider.models[0].id",
      "$.provider.baseUrl",
      "$.file",
      "$.providers",
      "$",
    ]);
    expect([...targets.at].sort()).toEqual(["baseUrl", "headers.2", "id", "models.0"]);
    expect([targets.file, targets.providers, targets.other]).toEqual([true, true, true]);
    expect(issueTargets([])).toEqual({ file: false, providers: false, other: false, at: new Set() });
  });

  it("slug proposes a valid identifier from a name", () => {
    expect(slug("My GPU Box!")).toBe("my-gpu-box");
    expect(slug("Ollama")).toBe("ollama");
    expect(slug("")).toBe("");
  });

  it("a kept auth or a kept header counts as a secret that rides along", () => {
    expect(carriesSecret(valid({ auth: { kind: "keep" } }))).toBe(true);
    expect(
      carriesSecret(valid({ auth: { kind: "none" }, headers: [{ name: "X-A", value: { kind: "keep" } }] })),
    ).toBe(true);
  });
});
