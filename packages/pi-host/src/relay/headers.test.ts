import { describe, expect, it } from "vitest";
import { upstreamHeaders } from "./headers.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-deny-list: forward every incoming header -> "drops what a VM must not send" fails.
 *  - M-credential-last: let an incoming credential header survive -> same case fails.
 */
const incoming = {
  "content-type": "application/json",
  accept: "text/event-stream",
  "accept-encoding": "gzip",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "x",
  "openai-beta": "y",
  "user-agent": "ua",
  "x-stainless-lang": "js",
  "x-stainless-retry-count": "0",
  authorization: "Bearer relaykey",
  "x-api-key": "relaykey",
  "x-goog-api-key": "relaykey",
  cookie: "a=b",
  host: "llm.internal:7842",
  "x-forwarded-for": "10.213.0.2",
  "proxy-authorization": "Basic zzz",
  "content-length": "12",
  "transfer-encoding": "chunked",
  connection: "keep-alive",
  "x-custom": "nope",
};
const credential = { value: "REALKEY", headers: {} };

describe("upstreamHeaders", () => {
  it("forwards only the allowed headers", () => {
    const out = upstreamHeaders("openai-completions", incoming, credential);
    expect(out).toEqual({
      "content-type": "application/json",
      accept: "text/event-stream",
      "accept-encoding": "gzip",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "x",
      "openai-beta": "y",
      "user-agent": "ua",
      "x-stainless-lang": "js",
      "x-stainless-retry-count": "0",
      authorization: "Bearer REALKEY",
    });
  });

  it("drops what a VM must not send (M-deny-list, M-credential-last)", () => {
    for (const api of [
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
      "google-generative-ai",
      "claude",
    ] as const) {
      const out = upstreamHeaders(api, incoming, credential);
      for (const name of [
        "cookie",
        "host",
        "x-forwarded-for",
        "proxy-authorization",
        "content-length",
        "transfer-encoding",
        "connection",
        "x-custom",
      ])
        expect(out, `${api} ${name}`).not.toHaveProperty(name);
      expect(JSON.stringify(out)).not.toContain("relaykey");
    }
  });

  it("sets the credential per api", () => {
    expect(upstreamHeaders("anthropic-messages", incoming, credential)["x-api-key"]).toBe("REALKEY");
    expect(upstreamHeaders("anthropic-messages", incoming, credential)).not.toHaveProperty("authorization");
    expect(upstreamHeaders("google-generative-ai", incoming, credential)["x-goog-api-key"]).toBe("REALKEY");
    expect(upstreamHeaders("google-generative-ai", incoming, credential)).not.toHaveProperty("authorization");
    expect(upstreamHeaders("openai-responses", incoming, credential).authorization).toBe("Bearer REALKEY");
    expect(upstreamHeaders("claude", incoming, credential).authorization).toBe("Bearer REALKEY");
  });

  it("adds the provider's literal headers, which win over the credential's default but never over the hop-by-hop set", () => {
    const out = upstreamHeaders("openai-completions", incoming, {
      value: "REALKEY",
      headers: {
        "x-org": "acme",
        authorization: "Token custom",
        host: "evil",
        "Content-Length": "1",
        cookie: "c=d",
      },
    });
    expect(out["x-org"]).toBe("acme");
    expect(out.authorization).toBe("Token custom");
    expect(out).not.toHaveProperty("host");
    expect(out).not.toHaveProperty("Content-Length");
    expect(out).not.toHaveProperty("cookie");
  });

  it("is a plain record: a header named __proto__ cannot reach the prototype", () => {
    const out = upstreamHeaders(
      "openai-completions",
      { "x-stainless-__proto__": "1", __proto__: "x" } as never,
      credential,
    );
    expect(Object.getPrototypeOf(out)).toBeNull();
  });
});
