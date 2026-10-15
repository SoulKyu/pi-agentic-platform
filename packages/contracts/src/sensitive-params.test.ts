import { describe, expect, it } from "vitest";
import { methods } from "./index.ts";

// MC30: a method whose params hold a secret says so, and the dispatcher keeps nothing derived from them.
describe("sensitiveParams", () => {
  it("marks exactly the Pi credential and configuration writes", () => {
    const marked = Object.values(methods)
      .filter((def) => "sensitiveParams" in def)
      .map((def) => def.name)
      .sort();
    expect(marked).toEqual([
      "automation.fire",
      "automation.triggers.create",
      "automation.triggers.update",
      "mcp.add",
      "models.config.save",
      "models.loginAnswer",
      "models.setApiKey",
      "sessions.respondDialog",
    ]);
  });

  it("names selector fields that exist in the params and are not the secret", () => {
    const secret: Record<string, string> = {
      "automation.fire": "payload",
      "automation.triggers.create": "input",
      "automation.triggers.update": "input",
      "mcp.add": "entry",
      "models.config.save": "text",
      "models.loginAnswer": "value",
      "models.setApiKey": "key",
      "sessions.respondDialog": "response",
    };
    for (const def of Object.values(methods)) {
      if (!def.sensitiveParams) continue;
      const shape = (def.params as unknown as { shape: Record<string, unknown> }).shape;
      // A create has no non-secret field to name: its receipt hashes no param at all.
      if (def.name !== "automation.triggers.create") expect(def.sensitiveParams.length).toBeGreaterThan(0);
      for (const field of def.sensitiveParams) {
        expect(Object.keys(shape), def.name).toContain(field);
        expect(field, def.name).not.toBe(secret[def.name]);
      }
    }
  });

  it("marks only mutations: an idempotent method has no receipt to protect", () => {
    for (const def of Object.values(methods))
      if ("sensitiveParams" in def) expect(def.idempotent).toBe(false);
  });
});
