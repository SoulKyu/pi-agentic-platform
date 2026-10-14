import { describe, expect, it } from "vitest";
import { HELPER_OPS, methods, MODELS_CONFIG_TEXT_MAX } from "./index.ts";

const revision = "a".repeat(64);

describe("models.config methods", () => {
  it("reads and saves with pi:admin only, so a token never gets the masked text (MC33)", () => {
    expect(methods["models.config.get"]).toMatchObject({ permission: "pi:admin", idempotent: true });
    expect(methods["models.config.save"]).toMatchObject({ permission: "pi:admin", idempotent: false });
    expect(methods["models.config.save"].errors).toContain("step_up_required");
    expect(methods["models.config.save"].errors).toContain("config_hard_link");
  });

  it("bounds the save params and refuses a path or a field of the client's choosing", () => {
    const { params } = methods["models.config.save"];
    expect(params.safeParse({ text: "{}", baseRevision: revision }).success).toBe(true);
    for (const bad of [
      { text: "{}", baseRevision: "short" },
      { text: "{}", baseRevision: revision.toUpperCase() },
      { text: "x".repeat(MODELS_CONFIG_TEXT_MAX + 1), baseRevision: revision },
      { text: "{}", baseRevision: revision, path: "/etc/passwd" },
      { text: 1, baseRevision: revision },
    ])
      expect(params.safeParse(bad).success).toBe(false);
  });

  it("answers a revision or a refusal with JSON paths, and nothing more", () => {
    const { result } = methods["models.config.save"];
    expect(result.safeParse({ revision, enabledModelsSynced: true }).success).toBe(true);
    expect(result.safeParse({ code: "config_invalid", issues: ["$.providers"] }).success).toBe(true);
    for (const bad of [
      { revision, enabledModelsSynced: true, text: "sk-1" },
      { revision },
      { code: "config_invalid", issues: [] },
      { code: "config_invalid", issues: Array.from({ length: 21 }, () => "$") },
      { code: "config_invalid", issues: ["x".repeat(101)] },
      { code: "config_invalid", issues: ["$"], message: "Unexpected token s in JSON" },
      { code: "conflict", issues: ["$"] },
    ])
      expect(result.safeParse(bad).success).toBe(false);
  });

  it("gets a text, or null for no file, with its revision and path", () => {
    const { result } = methods["models.config.get"];
    const view = { text: null, issues: [], revision, path: "/a/models.json" };
    expect(result.safeParse(view).success).toBe(true);
    expect(result.safeParse({ ...view, issues: ["line 3, column 9: invalid JSON"] }).success).toBe(true);
    expect(result.safeParse({ text: null, revision, path: "/a/models.json" }).success).toBe(false);
    expect(result.safeParse({ ...view, text: "{}", secrets: [] }).success).toBe(false);
    expect(result.safeParse({ ...view, issues: Array(21).fill("x") }).success).toBe(false);
  });

  it("is the helper op's schema too", () => {
    expect(HELPER_OPS["models.config.save"].result).toBe(methods["models.config.save"].result);
    const key = "c".repeat(64);
    expect(HELPER_OPS["models.config.get"].params.safeParse({ revisionKey: key }).success).toBe(true);
    expect(HELPER_OPS["models.config.get"].params.safeParse({}).success).toBe(false);
    expect(
      HELPER_OPS["models.config.save"].params.safeParse({
        text: "{}",
        baseRevision: revision,
        revisionKey: key,
      }).success,
    ).toBe(true);
    expect(
      HELPER_OPS["models.config.save"].params.safeParse({ text: "{}", baseRevision: revision }).success,
    ).toBe(false);
    // the browser never chooses the key
    expect(
      methods["models.config.save"].params.safeParse({ text: "{}", baseRevision: revision, revisionKey: key })
        .success,
    ).toBe(false);
  });
});
