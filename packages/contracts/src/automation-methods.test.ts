import { describe, expect, it } from "vitest";
import { methods, TOKEN_PERMISSIONS, TriggerView } from "./index.ts";

const names = Object.keys(methods).filter((name) => name.startsWith("automation.triggers."));
const SECRET = `pwh_${"A".repeat(43)}`;

const view = {
  id: "t1",
  name: "n",
  enabled: false,
  state: "ok",
  source: { type: "manual" },
  execution: {
    cwd: "/x",
    tools: ["read"],
    precheck: null,
    env: [],
    retryOnInterrupt: false,
    maxRunMinutes: 20,
    dailyBudgetUsd: null,
    mode: "auto-accept-edits",
    maxRunUsd: null,
  },
  prompt: "p",
  projectId: null,
  cwd: "/x",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  webhookUrl: null,
  secretRotatedAt: null,
  nextFireAt: null,
  lastFireAt: null,
  redacted: false,
};

describe("automation trigger methods", () => {
  it("declares exactly the seven trigger methods", () => {
    expect(names.sort()).toEqual([
      "automation.triggers.create",
      "automation.triggers.delete",
      "automation.triggers.get",
      "automation.triggers.list",
      "automation.triggers.rotateSecret",
      "automation.triggers.setEnabled",
      "automation.triggers.update",
    ]);
  });

  it("reads need automation:read; every write needs automation:admin, which no token holds (M10R1, M10R2)", () => {
    for (const name of names) {
      const def = methods[name as keyof typeof methods];
      const read = name.endsWith(".list") || name.endsWith(".get");
      expect(def.permission, name).toBe(read ? "automation:read" : "automation:admin");
      expect(def.idempotent, name).toBe(read);
    }
    expect(TOKEN_PERMISSIONS).not.toContain("automation:admin");
    expect(TOKEN_PERMISSIONS).toContain("automation:read");
  });

  it("marks create, update and rotateSecret as secretResult, and nothing else", () => {
    const marked = names.filter((name) => "secretResult" in methods[name as keyof typeof methods]);
    expect(marked.sort()).toEqual([
      "automation.triggers.create",
      "automation.triggers.rotateSecret",
      "automation.triggers.update",
    ]);
  });

  it("keeps the receipt of a create and an update away from the input that may hold a precheck credential", () => {
    expect(methods["automation.triggers.create"].sensitiveParams).toEqual([]);
    expect(methods["automation.triggers.update"].sensitiveParams).toEqual(["triggerId", "baseRevision"]);
  });

  it("refuses a secret that is not a pwh_ key in the answer of create and rotateSecret", () => {
    const create = methods["automation.triggers.create"].result;
    expect(create.safeParse({ trigger: view, secret: SECRET }).success).toBe(true);
    expect(create.safeParse({ trigger: view, secret: null }).success).toBe(true);
    expect(create.safeParse({ trigger: view, secret: "pwh_short" }).success).toBe(false);
    expect(methods["automation.triggers.rotateSecret"].result.safeParse({ secret: "x" }).success).toBe(false);
  });

  it("has no field for a secret in a trigger view", () => {
    expect(TriggerView.safeParse(view).success).toBe(true);
    expect(TriggerView.safeParse({ ...view, secret: SECRET }).success).toBe(false);
  });

  it("accepts an unreadable trigger's view with no source, execution or prompt", () => {
    const unreadable = { ...view, state: "unreadable", source: null, execution: null, prompt: null };
    expect(TriggerView.safeParse(unreadable).success).toBe(true);
  });

  it("decodes the create input with the source-dependent defaults", () => {
    const parsed = methods["automation.triggers.create"].params.parse({
      input: { name: "n", source: { type: "webhook" }, execution: { cwd: "/x" }, prompt: "p" },
    });
    expect(parsed.input.execution.mode).toBe("supervised");
    expect(parsed.input.execution.maxRunUsd).toBe(1);
  });
});
