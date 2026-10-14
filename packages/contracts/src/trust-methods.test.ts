import { describe, expect, it } from "vitest";
import {
  HELPER_OPS,
  methods,
  TRUST_AUDIT_REASONS,
  TRUST_LIMITS,
  TrustSetHelperResult,
  TrustSetResult,
  TrustStatus,
} from "./index.ts";

const resources = {
  mcpServers: [],
  extensions: [],
  skills: [],
  promptTemplates: 0,
  settingsKeys: [],
  systemPrompt: false,
  truncated: false,
  unlisted: [],
};
const status = {
  requiresTrust: true,
  decision: null,
  decisionPath: null,
  inherited: false,
  resources,
};

describe("trust methods", () => {
  it("reads and writes behind pi:admin, and only the write is a mutation (MC38, M7R103)", () => {
    expect(methods["trust.status"]).toMatchObject({ permission: "pi:admin", idempotent: true });
    expect(methods["trust.set"]).toMatchObject({ permission: "pi:admin", idempotent: false });
  });

  it("takes a folder and a decision of true, false or null (clear), nothing else", () => {
    const { params } = methods["trust.set"];
    for (const decision of [true, false, null])
      expect(params.safeParse({ cwd: "/w", decision }).success).toBe(true);
    expect(params.safeParse({ cwd: "/w" }).success).toBe(false);
    expect(params.safeParse({ cwd: "/w", decision: "yes" }).success).toBe(false);
    expect(params.safeParse({ cwd: "/w", decision: true, projects: [] }).success).toBe(false);
  });

  it("refuses a status with a field the schema does not list, so no value can ride along", () => {
    expect(TrustStatus.safeParse(status).success).toBe(true);
    expect(TrustStatus.safeParse({ ...status, extra: 1 }).success).toBe(false);
    expect(
      TrustStatus.safeParse({ ...status, resources: { ...resources, settingsKeys: ["a".repeat(129)] } })
        .success,
    ).toBe(false);
    expect(
      TrustStatus.safeParse({
        ...status,
        resources: { ...resources, extensions: Array(TRUST_LIMITS.extensions + 1).fill("x.ts") },
      }).success,
    ).toBe(false);
  });

  it("answers a set with ok, or with a typed refusal that has no free text", () => {
    expect(TrustSetResult.safeParse({ ok: true }).success).toBe(true);
    expect(TrustSetResult.safeParse({ ok: false, refusal: "holds-other-projects" }).success).toBe(true);
    expect(TrustSetResult.safeParse({ ok: false, refusal: "because I said so" }).success).toBe(false);
    expect(TrustSetHelperResult.safeParse({ ok: true, folder: "/w" }).success).toBe(true);
    expect(HELPER_OPS["trust.set"].params.safeParse({ decision: true, projects: ["/w/a"] }).success).toBe(
      true,
    );
    expect(HELPER_OPS["trust.status"].params.safeParse({}).success).toBe(true);
  });

  it("names the three audit reasons (M7R106)", () => {
    expect(TRUST_AUDIT_REASONS).toEqual(["project_trusted", "project_untrusted", "project_trust_cleared"]);
  });
});
