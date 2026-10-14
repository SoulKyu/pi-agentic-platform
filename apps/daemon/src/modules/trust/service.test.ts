import { PapError, TRUST_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { fakePool } from "../models/testing/bed.ts";
import { createTrustService } from "./service.ts";

const resources = {
  mcpServers: [],
  extensions: ["x.ts"],
  skills: [],
  promptTemplates: 0,
  settingsKeys: [],
  systemPrompt: false,
  truncated: false,
  unlisted: [],
};
const status = { requiresTrust: true, decision: null, decisionPath: null, inherited: false, resources };
const clock = createFakeClock();
const owner = () => testCaller({ stepUpUntil: clock.now() + 60_000 });
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

function bed(answer: (op: string) => unknown, pool?: HelperPool) {
  const fake = fakePool((call) => answer(call.op));
  const { logger, lines } = captureLogger();
  const audit: Array<Record<string, unknown>> = [];
  const restarts: Array<[string, string]> = [];
  const order: string[] = [];
  const service = createTrustService({
    helpers: pool ?? fake.pool,
    projects: {
      covers: (ownerId, cwd) => ownerId === "u1" && (cwd === "/w/api" || cwd.startsWith("/w/api/")),
      roots: (ownerId) => (ownerId === "u1" ? ["/w/api", "/w/web", "relative", "/w/\0bad"] : []),
    },
    sessions: {
      restartFolder: (ownerId, folder) => {
        order.push("restart");
        restarts.push([ownerId, folder]);
        return 1;
      },
    },
    audit: {
      append: (line) => {
        order.push("audit");
        audit.push({ ...line });
      },
    },
    logger,
    clock,
  });
  return { service, calls: fake.calls, lines, audit, restarts, order };
}

describe("trust.status", () => {
  it("asks the helper in the folder and returns what the contract accepts", async () => {
    const { service, calls } = bed(() => status);
    expect(await service.status(owner(), "/w/api")).toEqual(status);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "trust.status", params: {} });
    expect(calls[0]?.options.cwd).toBe("/w/api");
  });

  it("refuses a folder the caller has no project in, before a helper starts", async () => {
    const { service, calls } = bed(() => status);
    expect(await codeOf(service.status(owner(), "/etc"))).toBe("invalid_cwd");
    expect(await codeOf(service.status(testCaller({ userId: "u2" }), "/w/api"))).toBe("invalid_cwd");
    expect(calls).toHaveLength(0);
  });

  it("refuses a result with a field the contract does not list and logs none of it", async () => {
    const { service, lines } = bed(() => ({ ...status, secret: "sk-LEAK" }));
    expect(await codeOf(service.status(owner(), "/w/api"))).toBe("helper_failed");
    expect(JSON.stringify(lines)).not.toContain("sk-LEAK");
  });
});

describe("trust.set", () => {
  const saved = { ok: true, folder: "/w/api" };

  it("asks for the password step-up to trust, and does nothing before it", async () => {
    const { service, calls, audit, restarts } = bed(() => saved);
    expect(await codeOf(service.set(testCaller(), { cwd: "/w/api", decision: true }))).toBe(
      "step_up_required",
    );
    expect(calls).toHaveLength(0);
    expect(audit).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("trusts with a step-up: the helper gets the owner's project roots, the audit names the folder, then the workers restart", async () => {
    const { service, calls, audit, restarts, order } = bed(() => saved);
    expect(await service.set(owner(), { cwd: "/w/api", decision: true })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      op: "trust.set",
      params: { decision: true, projects: ["/w/api", "/w/web"] },
    });
    expect(calls[0]?.options.cwd).toBe("/w/api");
    expect(audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "policy",
        reason: "project_trusted",
        detail: { folder: "/w/api" },
      },
    ]);
    expect(restarts).toEqual([["u1", "/w/api"]]);
    expect(order).toEqual(["audit", "restart"]);
  });

  it("restarts under the folder the helper recorded (its real path), not the spelling the browser sent", async () => {
    const { service, audit, restarts } = bed(() => ({ ok: true, folder: "/real/api" }));
    await service.set(owner(), { cwd: "/w/api/link", decision: true });
    expect(restarts).toEqual([["u1", "/real/api"]]);
    expect(audit[0]?.detail).toEqual({ folder: "/real/api" });
  });

  it("distrusts without a step-up and clears with one, under their own audit reasons", async () => {
    const { service, audit, restarts } = bed(() => saved);
    expect(await service.set(testCaller(), { cwd: "/w/api", decision: false })).toEqual({ ok: true });
    expect(await service.set(owner(), { cwd: "/w/api", decision: null })).toEqual({ ok: true });
    expect(audit.map((line) => line.reason)).toEqual(["project_untrusted", "project_trust_cleared"]);
    expect(restarts).toHaveLength(2);
  });

  it("asks for a live step-up to clear: removing a false under a trusted parent widens trust (MC47)", async () => {
    const { service, calls, audit, restarts } = bed(() => saved);
    expect(await codeOf(service.set(testCaller(), { cwd: "/w/api", decision: null }))).toBe(
      "step_up_required",
    );
    expect(
      await codeOf(
        service.set(testCaller({ stepUpUntil: clock.now() - 1 }), { cwd: "/w/api", decision: null }),
      ),
    ).toBe("step_up_required");
    expect([calls, audit, restarts]).toEqual([[], [], []]);
  });

  it("trusts only when the breadth rule can compare with every project: past the cap it fails closed (capacity)", async () => {
    const roots = Array.from({ length: TRUST_LIMITS.projects + 1 }, (_, i) => `/w/p${i}`);
    const fake = fakePool(() => saved);
    const { logger, lines } = captureLogger();
    const service = createTrustService({
      helpers: fake.pool,
      projects: { covers: () => true, roots: () => roots },
      sessions: { restartFolder: () => 0 },
      audit: { append: () => {} },
      logger,
      clock,
    });
    expect(await codeOf(service.set(owner(), { cwd: "/w/api", decision: true }))).toBe("capacity");
    expect(fake.calls).toHaveLength(0);
    expect(lines.some((line) => line.msg === "trust_projects_over_cap")).toBe(true);
    // Narrowing does not use the list, and the cap itself is still accepted.
    expect(await service.set(owner(), { cwd: "/w/api", decision: false })).toEqual({ ok: true });
    const exact = createTrustService({
      helpers: fake.pool,
      projects: { covers: () => true, roots: () => roots.slice(0, TRUST_LIMITS.projects) },
      sessions: { restartFolder: () => 0 },
      audit: { append: () => {} },
      logger,
      clock,
    });
    expect(await exact.set(owner(), { cwd: "/w/api", decision: true })).toEqual({ ok: true });
  });

  it("answers a breadth refusal with its rule, and neither audits nor restarts", async () => {
    const { service, audit, restarts } = bed(() => ({ ok: false, refusal: "home-or-above" }));
    expect(await service.set(owner(), { cwd: "/w/api", decision: true })).toEqual({
      ok: false,
      refusal: "home-or-above",
    });
    expect(audit).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("refuses a folder the caller has no project in, before a helper starts", async () => {
    const { service, calls } = bed(() => saved);
    expect(await codeOf(service.set(owner(), { cwd: "/etc", decision: true }))).toBe("invalid_cwd");
    expect(await codeOf(service.set(owner(), { cwd: "/etc", decision: null }))).toBe("invalid_cwd");
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the helper fails: no audit row, no restart", async () => {
    const { service, audit, restarts } = bed(() => new PapError("helper_failed"));
    expect(await codeOf(service.set(owner(), { cwd: "/w/api", decision: true }))).toBe("helper_failed");
    expect(audit).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("keeps the decision when the restart throws, and logs it", async () => {
    const fake = fakePool(() => saved);
    const { logger, lines } = captureLogger();
    const service = createTrustService({
      helpers: fake.pool,
      projects: { covers: () => true, roots: () => [] },
      sessions: {
        restartFolder: () => {
          throw new Error("boom");
        },
      },
      audit: { append: () => {} },
      logger,
      clock,
    });
    expect(await service.set(owner(), { cwd: "/w/api", decision: true })).toEqual({ ok: true });
    expect(lines.some((line) => line.msg === "trust_restart_failed")).toBe(true);
  });

  it("starts the second decision's helper only after the first one ended", async () => {
    const started: string[] = [];
    const gates: Array<(value: unknown) => void> = [];
    const pool: HelperPool = {
      run: (_op, params) => {
        started.push(String((params as { decision: unknown }).decision));
        const done = new Promise<unknown>((resolve) => gates.push(resolve));
        return { done, answer: () => false, cancel: () => {} };
      },
      active: () => 0,
      stopAll: async () => {},
    };
    const { service } = bed(() => saved, pool);
    const first = service.set(owner(), { cwd: "/w/api", decision: true });
    const second = service.set(owner(), { cwd: "/w/api", decision: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual(["true"]);
    gates[0]?.(saved);
    await first;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual(["true", "false"]);
    gates[1]?.(saved);
    await second;
  });
});
