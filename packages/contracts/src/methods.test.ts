import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, methods } from "./index.ts";

describe("method catalogue", () => {
  it("keys every method by its own name and declares a known permission", () => {
    for (const [key, def] of Object.entries(methods)) {
      expect(def.name).toBe(key);
      expect(ALL_PERMISSIONS).toContain(def.permission);
    }
  });

  it("marks exactly the mutations as non-idempotent (they require a commandId)", () => {
    const mutations = Object.values(methods)
      .filter((def) => !def.idempotent)
      .map((def) => def.name)
      .sort();
    expect(mutations).toEqual(["sessions.create", "sessions.prompt", "sessions.respondDialog"]);
  });
});
