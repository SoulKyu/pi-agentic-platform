import { describe, expect, it } from "vitest";
import { modelOf, pathAllowed, routeOf } from "./routes.ts";

/*
 * Mutants (RT-43), each run for real and killed by the case named:
 *  - M-segment: drop the "." / ".." segment check in `routeOf` -> "refuses dot segments" fails.
 *  - M-method: accept any method -> "refuses every method but POST" fails.
 *  - M-map: PATHS as a plain object instead of a Map -> "pathAllowed is false for names an object would find" fails.
 */
describe("routeOf", () => {
  it("routes a provider request", () => {
    expect(routeOf("POST", "llm.internal:7842", "/zai/chat/completions")).toEqual({
      kind: "provider",
      provider: "zai",
      path: "/chat/completions",
      query: "",
    });
  });

  it("routes the bridge, with its beta query", () => {
    expect(routeOf("POST", "claude.internal:7842", "/v1/messages?beta=true")).toEqual({
      kind: "claude",
      path: "/v1/messages",
      query: "?beta=true",
    });
    expect(routeOf("POST", "claude.internal", "/v1/messages/count_tokens")).toEqual({
      kind: "claude",
      path: "/v1/messages/count_tokens",
      query: "",
    });
  });

  it("routes a Google streaming path with its version segment and ?alt=sse", () => {
    expect(
      routeOf(
        "POST",
        "llm.internal:7842",
        "/google/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      ),
    ).toEqual({
      kind: "provider",
      provider: "google",
      path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      query: "?alt=sse",
    });
  });

  it("refuses every method but POST (M-method)", () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "post", "Post", "", undefined])
      expect(routeOf(method, "llm.internal:7842", "/zai/chat/completions")).toBeNull();
  });

  it("refuses a Host that is not exactly one of the two names", () => {
    const hosts = [
      "api.z.ai",
      "llm.internal.evil",
      "evil.llm.internal",
      undefined,
      "llm.internal:7842:1",
      "llm.internal@evil",
      "",
      "llm.internal:",
      "llm.internal:123456",
      " llm.internal",
      "llm.internal ",
      "claude.internal.evil",
    ];
    for (const host of hosts) expect(routeOf("POST", host, "/zai/chat/completions")).toBeNull();
  });

  it("refuses dot segments, encodings and odd request targets (M-segment)", () => {
    const targets = [
      "/zai/../../etc/passwd",
      "/zai/%2e%2e/x",
      "http://api.z.ai/chat/completions",
      "//zai/x",
      "/zai\\x",
      "/zai/chat/completions?x=1",
      "/zai/chat/completions#frag",
      "/zai",
      "/zai/",
      "/Zai/x",
      "/zai/.../x",
      "/zai/./x",
      "/zai/chat/completions\r\nHost: evil",
      "/zai/chat/completions\n",
      "",
      "*",
      "zai/chat/completions",
      "/zai/chat/completions?",
      "/zai/chat/completions?beta=true&x=1",
      "/zai/a b",
    ];
    for (const target of targets) expect(routeOf("POST", "llm.internal:7842", target), target).toBeNull();
  });

  it("refuses the bridge's other paths", () => {
    for (const target of [
      "/v1/complete",
      "/v1/messages/../models",
      "/v1/models",
      "/",
      "/v1/messages/",
      "/v1/messages/x",
    ])
      expect(routeOf("POST", "claude.internal:7842", target), target).toBeNull();
  });

  it("lower-cases the Host before judging it", () => {
    expect(routeOf("POST", "LLM.Internal:7842", "/zai/chat/completions")?.kind).toBe("provider");
  });
});

describe("pathAllowed", () => {
  it("is false for names an object would find (M-map)", () => {
    for (const api of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "unknown", ""])
      expect(pathAllowed(api, "/v1/messages")).toBe(false);
  });

  it("follows the table for each api", () => {
    expect(pathAllowed("anthropic-messages", "/v1/messages")).toBe(true);
    expect(pathAllowed("anthropic-messages", "/v1/messages/count_tokens")).toBe(true);
    expect(pathAllowed("anthropic-messages", "/v1/complete")).toBe(false);
    expect(pathAllowed("anthropic-messages", "/chat/completions")).toBe(false);
    expect(pathAllowed("openai-completions", "/chat/completions")).toBe(true);
    expect(pathAllowed("openai-completions", "/responses")).toBe(false);
    expect(pathAllowed("openai-responses", "/responses")).toBe(true);
    expect(pathAllowed("openai-responses", "/chat/completions")).toBe(false);
  });

  it("allows Google with and without /v1beta, and only its three methods", () => {
    const stream = "/models/gemini-2.5-pro:streamGenerateContent";
    expect(pathAllowed("google-generative-ai", stream)).toBe(true);
    expect(pathAllowed("google-generative-ai", `/v1beta${stream}`)).toBe(true);
    expect(pathAllowed("google-generative-ai", `/v1${stream}`)).toBe(true);
    expect(pathAllowed("google-generative-ai", "/models/x:generateContent")).toBe(true);
    expect(pathAllowed("google-generative-ai", "/models/x:countTokens")).toBe(true);
    expect(pathAllowed("google-generative-ai", "/models/x:embedContent")).toBe(false);
    expect(pathAllowed("google-generative-ai", "/v2/models/x:generateContent")).toBe(false);
    expect(pathAllowed("google-generative-ai", "/v1beta/tunedModels/x:generateContent")).toBe(false);
  });
});

describe("modelOf", () => {
  const body = (value: unknown) => Buffer.from(JSON.stringify(value));
  it("reads the body's model", () => {
    expect(modelOf("openai-completions", "/chat/completions", body({ model: "glm-4.6" }))).toBe("glm-4.6");
  });
  it("refuses a non-object, a non-string, a long model and bad JSON", () => {
    for (const value of [
      [],
      "x",
      3,
      null,
      { model: 3 },
      { model: null },
      { model: "" },
      {},
      { model: "m".repeat(257) },
    ])
      expect(modelOf("openai-completions", "/chat/completions", body(value))).toBeNull();
    expect(modelOf("openai-completions", "/chat/completions", Buffer.from("{not json"))).toBeNull();
    expect(modelOf("openai-completions", "/chat/completions", Buffer.alloc(0))).toBeNull();
  });
  it("accepts a 256-character model", () => {
    expect(modelOf("openai-completions", "/x", body({ model: "m".repeat(256) }))).toBe("m".repeat(256));
  });
  it("reads Google's model from the path, never the body", () => {
    expect(
      modelOf(
        "google-generative-ai",
        "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
        body({ model: "other" }),
      ),
    ).toBe("gemini-2.5-pro");
    expect(modelOf("google-generative-ai", "/chat/completions", body({ model: "other" }))).toBeNull();
  });
});
