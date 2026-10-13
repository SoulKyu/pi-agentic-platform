import { describe, expect, it } from "vitest";
import { sessionPolicyEn, sessionPolicyFr } from "./session-policy.ts";
import { settingsApprovalsEn, settingsApprovalsFr } from "./settings-approvals.ts";

describe("owner-facing copy of the access milestone (M6, M7 of the M5 final review)", () => {
  it("names the audit rows of kind auth after access, not sign-in: they hold step-up, token, device and passkey events", () => {
    expect(settingsApprovalsEn["audit.kind.auth"]).toBe("Access");
    expect(settingsApprovalsFr["audit.kind.auth"]).toBe("Accès");
  });

  it("states in the full-access confirmation what still asks, as the Settings copy does", () => {
    const en = sessionPolicyEn["sessionPolicy.confirmFull"];
    expect(en).toMatch(/outside the project/);
    expect(en).toMatch(/protected/);
    expect(en).toMatch(/pap's own secrets/);
    const fr = sessionPolicyFr["sessionPolicy.confirmFull"];
    expect(fr).toMatch(/hors du projet/);
    expect(fr).toMatch(/protégés/);
    expect(fr).toMatch(/secrets de pap/);
    expect(settingsApprovalsEn["approvals.mode.full-access.limits"]).toMatch(/outside the project/);
  });
});
