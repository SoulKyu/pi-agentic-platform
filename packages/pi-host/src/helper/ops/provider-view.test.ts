import { describe, expect, it } from "vitest";
import { viewOf } from "./provider-view.ts";

const base = { api: "openai-completions", baseUrl: "https://api.example.com/v1" };

describe("viewOf", () => {
  it("maps apiKey to an auth kind and never returns a literal", () => {
    const auth = (apiKey?: unknown) => {
      const view = viewOf("mine", { ...base, ...(apiKey === undefined ? {} : { apiKey }) });
      return view.editable ? view.provider.auth : view;
    };
    expect(auth()).toEqual({ kind: "stored" });
    expect(auth("local-no-key")).toEqual({ kind: "none" });
    expect(auth("$MY_KEY")).toEqual({ kind: "env", name: "MY_KEY" });
    expect(auth("${MY_KEY}")).toEqual({ kind: "env", name: "MY_KEY" });
    expect(auth("sk-LITERAL")).toEqual({ kind: "keep" });
    expect(auth("!pass show x")).toEqual({ kind: "keep" });
    expect(auth(42)).toEqual({ kind: "keep" });
  });

  it("gives a reason for what the form cannot hold", () => {
    expect(viewOf("a", null)).toEqual({ editable: false, reason: "needs_raw_editor" });
    expect(viewOf("a", { ...base, api: "bedrock-converse-stream" })).toEqual({
      editable: false,
      reason: "api_unsupported",
    });
    expect(viewOf("a", { ...base, baseUrl: "https://x.example.com?q=1" })).toEqual({
      editable: false,
      reason: "url_unsupported",
    });
    expect(viewOf("a", { ...base, baseUrl: 3 })).toEqual({ editable: false, reason: "needs_raw_editor" });
    expect(viewOf("a", { ...base, headers: [] })).toEqual({ editable: false, reason: "needs_raw_editor" });
    expect(viewOf("a", { ...base, headers: { "X-A": 1 } })).toEqual({
      editable: false,
      reason: "needs_raw_editor",
    });
    expect(viewOf("a", { ...base, models: {} })).toEqual({ editable: false, reason: "needs_raw_editor" });
    expect(viewOf("A", base)).toEqual({ editable: false, reason: "needs_raw_editor" });
  });

  it("masks every literal header value as keep, keeps env references as env", () => {
    const view = viewOf("a", {
      ...base,
      headers: { "X-Client-Id": "id-4242", "X-Team": "red", "X-Org": "$ORG_ID" },
    });
    expect(view).toMatchObject({
      editable: true,
      provider: {
        headers: [
          { name: "X-Client-Id", value: { kind: "keep" } },
          { name: "X-Team", value: { kind: "keep" } },
          { name: "X-Org", value: { kind: "env", name: "ORG_ID" } },
        ],
      },
    });
    expect(JSON.stringify(view)).not.toContain("id-4242");
  });

  it("flags advanced for unowned keys only", () => {
    expect(viewOf("a", { ...base, models: [{ id: "m" }] })).toMatchObject({
      editable: true,
      advanced: false,
    });
    expect(viewOf("a", { ...base, authHeader: true })).toMatchObject({ editable: true, advanced: true });
    expect(viewOf("a", { ...base, models: [{ id: "m", cost: {} }] })).toMatchObject({
      editable: true,
      advanced: true,
    });
  });
});
