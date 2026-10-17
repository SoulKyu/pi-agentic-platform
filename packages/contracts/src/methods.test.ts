import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_GATE_ERRORS, ALL_PERMISSIONS, methods } from "./index.ts";

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
    expect(mutations).toEqual([
      "agents.answerApproval",
      "agents.create",
      "agents.delete",
      "agents.markRead",
      "agents.openThread",
      "agents.quarantine",
      "agents.queueTask",
      "agents.resetThread",
      "agents.setPaused",
      "agents.update",
      "auth.devices.revoke",
      "auth.devices.revokeOthers",
      "auth.passkeys.remove",
      "auth.tokens.create",
      "auth.tokens.revoke",
      "automation.failures.dismiss",
      "automation.fire",
      "automation.tasks.cancel",
      "automation.tasks.releaseTools",
      "automation.tasks.retry",
      "automation.triggers.create",
      "automation.triggers.delete",
      "automation.triggers.rotateSecret",
      "automation.triggers.setEnabled",
      "automation.triggers.update",
      "files.write",
      "inbox.markRead",
      "lanes.approveScripts",
      "lanes.archive",
      "lanes.closeLosers",
      "lanes.commit",
      "lanes.create",
      "lanes.newSession",
      "lanes.prCreate",
      "lanes.push",
      "lanes.restore",
      "lanes.reviewState.set",
      "lanes.runScript",
      "lanes.suggestCommit",
      "mcp.add",
      "mcp.remove",
      "mcp.setCodemode",
      "mcp.setEnabled",
      "mcp.setExposure",
      "mcp.setInProject",
      "mcp.test",
      "mcp.undo",
      "memory.decide",
      "memory.forget",
      "memory.save",
      "models.cancelLogin",
      "models.config.save",
      "models.discover",
      "models.login",
      "models.loginAnswer",
      "models.loginCancel",
      "models.logout",
      "models.provider.remove",
      "models.provider.save",
      "models.refreshCatalog",
      "models.setApiKey",
      "models.setDefault",
      "models.setDefaultThinking",
      "models.setEnabled",
      "models.test",
      "plugins.install",
      "plugins.remove",
      "plugins.setEnabled",
      "plugins.update",
      "policy.clearTaint",
      "policy.revokeRule",
      "policy.setSessionMode",
      "policy.setSettings",
      "projects.update",
      "push.revoke",
      "push.subscribe",
      "push.test",
      "secrets.answerRequest",
      "secrets.declineRequest",
      "secrets.delete",
      "secrets.set",
      "sessions.abort",
      "sessions.autoName",
      "sessions.clearQueue",
      "sessions.clone",
      "sessions.compact",
      "sessions.create",
      "sessions.exportHtml",
      "sessions.fork",
      "sessions.mark",
      "sessions.navigate",
      "sessions.prompt",
      "sessions.rename",
      "sessions.reopen",
      "sessions.respondDialog",
      "sessions.setModel",
      "sessions.setThinking",
      "sessions.setTools",
      "settings.set",
      "skills.install",
      "skills.setInvocation",
      "subagents.cancel",
      "trust.set",
      "usage.cancelResume",
      "usage.resumeNow",
    ]);
  });

  it("declares the session reads as idempotent sessions:read queries", () => {
    for (const name of ["sessions.history", "sessions.toolOutput", "sessions.branches"] as const) {
      expect(methods[name]).toMatchObject({ permission: "sessions:read", idempotent: true });
    }
  });

  it("declares panelInput as the one idempotent sessions:operate write, with bounded data", () => {
    const def = methods["sessions.panelInput"];
    expect(def).toMatchObject({ permission: "sessions:operate", idempotent: true, errors: ["not_found"] });
    const ok = { sessionId: "s", panelId: "p", data: "x" };
    expect(def.params.safeParse(ok).success).toBe(true);
    expect(def.params.safeParse({ ...ok, data: "x".repeat(4096) }).success).toBe(true);
    for (const bad of [
      { data: "" },
      { data: "x".repeat(4097) },
      { panelId: "" },
      { panelId: "p".repeat(129) },
      { data: 4 },
    ]) {
      expect(def.params.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
    expect(def.result.safeParse({ ok: true }).success).toBe(true);
  });

  it("declares clearQueue as a sessions:operate mutation that can time out", () => {
    expect(methods["sessions.clearQueue"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
      errors: ["not_found", "worker_failed", "timeout", ...AGENT_GATE_ERRORS],
    });
    expect(methods["sessions.prompt"].errors).toContain("queue_full");
  });

  it("declares navigate and compact as sessions:operate mutations that cannot time out", () => {
    const shared = ["forbidden", "not_found", "session_busy", "capacity", "worker_failed", "command_failed"];
    expect(methods["sessions.navigate"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
      errors: [...shared, ...AGENT_GATE_ERRORS],
    });
    expect(methods["sessions.compact"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
      errors: [...shared, "session_empty", ...AGENT_GATE_ERRORS],
    });
    expect(methods["sessions.prompt"].errors).toContain("session_busy");
    const { params, result } = methods["sessions.navigate"];
    expect(params.safeParse({ sessionId: "s", targetId: "e1" }).success).toBe(true);
    for (const bad of [{ targetId: "" }, { targetId: "e".repeat(129) }, { sessionId: "" }]) {
      expect(params.safeParse({ sessionId: "s", targetId: "e1", ...bad }).success).toBe(false);
    }
    expect(result.safeParse({ cancelled: false }).success).toBe(true);
    expect(result.safeParse({ cancelled: true, editorText: "q" }).success).toBe(true);
    expect(result.safeParse({ editorText: "q" }).success).toBe(false);
    const compact = methods["sessions.compact"];
    expect(compact.params.safeParse({ sessionId: "s" }).success).toBe(true);
    expect(compact.params.safeParse({ sessionId: "s", customInstructions: "x".repeat(4096) }).success).toBe(
      true,
    );
    expect(compact.params.safeParse({ sessionId: "s", customInstructions: "x".repeat(4097) }).success).toBe(
      false,
    );
    expect(compact.result.safeParse({ tokensBefore: 10, estimatedTokensAfter: null }).success).toBe(true);
    expect(compact.result.safeParse({ tokensBefore: 10 }).success).toBe(false);
  });

  it("declares rename and autoName as sessions:operate mutations whose timeout means unknown", () => {
    expect(methods["sessions.rename"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
      errors: [
        "not_found",
        "bad_request",
        "capacity",
        "worker_failed",
        "command_failed",
        "timeout",
        ...AGENT_GATE_ERRORS,
      ],
    });
    expect(methods["sessions.autoName"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
      errors: [
        "forbidden",
        "not_found",
        "session_empty",
        "timeout",
        "capacity",
        "worker_failed",
        "command_failed",
        ...AGENT_GATE_ERRORS,
      ],
    });
    const { params } = methods["sessions.rename"];
    expect(params.safeParse({ sessionId: "s", name: "Fix" }).success).toBe(true);
    expect(params.safeParse({ sessionId: "s", name: "😀".repeat(256) }).success).toBe(true);
    for (const name of ["", "   ", "\n\t", "x".repeat(513), 4]) {
      expect(params.safeParse({ sessionId: "s", name }).success).toBe(false);
    }
    expect(methods["sessions.autoName"].result.safeParse({ name: "Fix" }).success).toBe(true);
    expect(methods["sessions.autoName"].result.safeParse({ name: "" }).success).toBe(false);
  });

  it("declares exportHtml as a sessions:operate mutation whose timeout means unknown, answering a download path", () => {
    expect(methods["sessions.exportHtml"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
      errors: ["not_found", "capacity", "timeout", "worker_failed", "command_failed", ...AGENT_GATE_ERRORS],
    });
    const def = methods["sessions.exportHtml"];
    expect(def.params.safeParse({ sessionId: "s" }).success).toBe(true);
    expect(def.params.safeParse({ sessionId: "" }).success).toBe(false);
    const url = `/api/sessions/s/export/${"A".repeat(43)}`;
    expect(def.result.safeParse({ url }).success).toBe(true);
    for (const bad of ["", "https://evil.example/x", "//evil.example/x", `${url}?x`, "x".repeat(400)]) {
      expect(def.result.safeParse({ url: bad }).success, bad).toBe(false);
    }
  });

  it("declares fork and clone as sessions:operate mutations with the errors a caller can handle", () => {
    expect(methods["sessions.fork"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
      errors: ["not_found", "bad_request", "session_empty", "capacity", "rate_limited", "disk_low"],
    });
    expect(methods["sessions.clone"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
      errors: ["not_found", "bad_request", "session_empty", "capacity", "rate_limited", "disk_low"],
    });
    const fork = methods["sessions.fork"];
    expect(fork.params.safeParse({ sessionId: "s", entryId: "e".repeat(128) }).success).toBe(true);
    for (const bad of [{ entryId: "" }, { entryId: "e".repeat(129) }, {}]) {
      expect(fork.params.safeParse({ sessionId: "s", ...bad }).success).toBe(false);
    }
    expect(fork.result.safeParse({ sessionId: "p", text: "x".repeat(200_001) }).success).toBe(false);
  });

  it("bounds what a history request can ask for", () => {
    const { params } = methods["sessions.history"];
    expect(params.safeParse({ sessionId: "s", before: "e1", limit: 100 }).success).toBe(true);
    expect(params.safeParse({ sessionId: "s", before: "e1" }).success).toBe(true);
    for (const bad of [
      { before: "" },
      { before: "e".repeat(129) },
      { before: "e1", limit: 0 },
      { before: "e1", limit: 101 },
    ]) {
      expect(params.safeParse({ sessionId: "s", ...bad }).success).toBe(false);
    }
    const tool = methods["sessions.toolOutput"].params;
    expect(tool.safeParse({ sessionId: "s", toolCallId: "c".repeat(256) }).success).toBe(true);
    expect(tool.safeParse({ sessionId: "s", toolCallId: "c".repeat(257) }).success).toBe(false);
    expect(tool.safeParse({ sessionId: "s", toolCallId: "" }).success).toBe(false);
    expect(tool.safeParse({ sessionId: "s", toolCallId: "c", resultEntryId: "e".repeat(128) }).success).toBe(
      true,
    );
    expect(tool.safeParse({ sessionId: "s", toolCallId: "c", resultEntryId: "e".repeat(129) }).success).toBe(
      false,
    );
    expect(tool.safeParse({ sessionId: "s", toolCallId: "c", resultEntryId: "" }).success).toBe(false);
  });

  it("declares the policy methods: a read for the caller's rules, an admin mutation to revoke one", () => {
    expect(methods["policy.listRules"]).toMatchObject({
      permission: "policy:read",
      idempotent: true,
      errors: [],
    });
    expect(methods["policy.revokeRule"]).toMatchObject({
      permission: "policy:admin",
      idempotent: false,
      errors: ["not_found"],
    });
    const list = methods["policy.listRules"];
    expect(list.params.safeParse({}).success).toBe(true);
    expect(list.params.safeParse({ cwd: "/w" }).success).toBe(true);
    expect(list.params.safeParse({ cwd: "" }).success).toBe(false);
    expect(list.params.safeParse({ cwd: "c".repeat(4097) }).success).toBe(false);
    const rule = { id: "r1", scope: "/w", tool: "bash", label: "l", createdAt: 1, kind: "exact" };
    expect(list.result.safeParse({ rules: [rule], truncated: false }).success).toBe(true);
    expect(list.result.safeParse({ rules: [rule] }).success).toBe(false);
    expect(list.result.safeParse({ rules: Array(1001).fill(rule), truncated: true }).success).toBe(false);
    const revoke = methods["policy.revokeRule"].params;
    expect(revoke.safeParse({ ruleId: "r1" }).success).toBe(true);
    expect(revoke.safeParse({ ruleId: "" }).success).toBe(false);
    expect(revoke.safeParse({ ruleId: "r".repeat(129) }).success).toBe(false);
  });

  it("declares the policy v2 methods (M5R53): a read, and three admin mutations that come from policyMethods", () => {
    expect(methods["policy.getSettings"]).toMatchObject({
      permission: "policy:read",
      idempotent: true,
      errors: [],
    });
    expect(methods["policy.setSettings"]).toMatchObject({
      permission: "policy:admin",
      idempotent: false,
      errors: ["bad_request", "conflict"],
    });
    for (const name of ["policy.setSessionMode", "policy.clearTaint"] as const) {
      expect(methods[name]).toMatchObject({
        permission: "policy:admin",
        idempotent: false,
        errors: ["not_found"],
      });
    }
    const source = readFileSync(new URL("./methods.ts", import.meta.url), "utf8");
    for (const name of ["getSettings", "setSettings", "setSessionMode", "clearTaint"]) {
      expect(source).not.toContain(`"policy.${name}": defineMethod`);
    }
    const mode = methods["policy.setSessionMode"].params;
    expect(mode.safeParse({ sessionId: "s", mode: null }).success).toBe(true);
    expect(mode.safeParse({ sessionId: "s", mode: "read-only" }).success).toBe(true);
    for (const bad of [{ mode: "yolo" }, { mode: undefined }, { sessionId: "" }]) {
      expect(mode.safeParse({ sessionId: "s", mode: null, ...bad }).success).toBe(false);
    }
    const set = methods["policy.setSettings"].params;
    expect(set.safeParse({ value: {}, baseRevision: 0 }).success).toBe(true);
    expect(set.safeParse({ value: { extra: 1 }, baseRevision: 0 }).success).toBe(false);
    expect(set.safeParse({ value: {}, baseRevision: -1 }).success).toBe(false);
    const get = methods["policy.getSettings"].result;
    expect(get.safeParse({ value: null, revision: 0 }).success).toBe(true);
    expect(get.safeParse({ revision: 0 }).success).toBe(false);
  });
});

describe("the vcs methods come from vcsMethods", () => {
  it("are spread from the domain list, never defined inline (M5R111)", () => {
    const source = readFileSync(new URL("./methods.ts", import.meta.url), "utf8");
    expect(source).toContain("...vcsMethods");
    for (const name of ["subscribe.vcs", "vcs.refresh", "vcs.fileDiff"])
      expect(source).not.toContain(`"${name}": defineMethod`);
  });
});

describe("sessions.prompt attachments (M8R40)", () => {
  const { params } = methods["sessions.prompt"];
  const id = "a".repeat(22);
  it("refuses an empty text without attachments and accepts it with one", () => {
    expect(params.safeParse({ sessionId: "s", text: "" }).success).toBe(false);
    expect(params.safeParse({ sessionId: "s", text: "", attachments: [] }).success).toBe(false);
    expect(params.safeParse({ sessionId: "s", text: "", attachments: [id] }).success).toBe(true);
    expect(params.safeParse({ sessionId: "s", text: "hello", attachments: [id] }).success).toBe(true);
  });
  it("caps the list at 10 and checks every id's shape", () => {
    const ten = Array.from({ length: 10 }, (_, index) => String(index).padStart(22, "a"));
    expect(params.safeParse({ sessionId: "s", text: "x", attachments: ten }).success).toBe(true);
    expect(params.safeParse({ sessionId: "s", text: "x", attachments: [...ten, id] }).success).toBe(false);
    expect(params.safeParse({ sessionId: "s", text: "x", attachments: ["a".repeat(21)] }).success).toBe(
      false,
    );
  });
});
