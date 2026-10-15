import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { fakePool } from "../models/testing/bed.ts";
import { createTrustService } from "./service.ts";

const status = (decision: boolean | null) => ({
  requiresTrust: true,
  decision,
  decisionPath: decision === null ? null : "/w/api",
  inherited: false,
  resources: {
    mcpServers: [],
    extensions: [],
    skills: [],
    promptTemplates: 0,
    settingsKeys: [],
    systemPrompt: false,
    truncated: false,
    unlisted: [],
  },
});

/** `trust.status` of the source project says trusted; every other op answers `other`. */
const trustedSource = (other: unknown) => (op: string) => (op === "trust.status" ? status(true) : other);

function bed(answer: (op: string) => unknown) {
  const fake = fakePool((call) => answer(call.op));
  const { logger, lines } = captureLogger();
  const audit: Array<Record<string, unknown>> = [];
  const restarts: unknown[] = [];
  const service = createTrustService({
    helpers: fake.pool,
    projects: { covers: () => false, roots: (owner) => (owner === "u1" ? ["/w/api", "/w/web"] : []) },
    sessions: { restartFolder: (...args) => (restarts.push(args), 0) },
    audit: { append: (line) => void audit.push({ ...line }) },
    logger,
    clock: createFakeClock(),
  });
  return { port: service.port, calls: fake.calls, audit, lines, restarts };
}

describe("trust port (M9R39)", () => {
  it("status answers the decision the helper reports, asking in the folder", async () => {
    const { port, calls } = bed(() => status(true));
    expect(await port.status("/lanes/a")).toBe(true);
    expect(calls[0]).toMatchObject({ op: "trust.status", params: {} });
    expect(calls[0]?.options.cwd).toBe("/lanes/a");
    expect(await bed(() => status(null)).port.status("/lanes/a")).toBeNull();
  });

  it("status answers null on a helper error, a malformed answer or a relative folder", async () => {
    const failing = bed(() => {
      throw new Error("helper down");
    });
    expect(await failing.port.status("/lanes/a")).toBeNull();
    expect(await bed(() => ({ nope: 1 })).port.status("/lanes/a")).toBeNull();
    const { port, calls } = bed(() => status(true));
    expect(await port.status("relative/path")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("inherit writes true for the folder with the owner's project roots, and audits where it came from", async () => {
    const { port, calls, audit, restarts } = bed(trustedSource({ ok: true, folder: "/real/lanes/a" }));
    expect(await port.inherit("u1", "/lanes/a", "/w/api")).toBe(true);
    expect(calls[0]).toMatchObject({ op: "trust.status" });
    expect(calls[0]?.options.cwd).toBe("/w/api");
    expect(calls[1]).toMatchObject({
      op: "trust.set",
      params: { decision: true, projects: ["/w/api", "/w/web"] },
    });
    expect(calls[1]?.options.cwd).toBe("/lanes/a");
    expect(audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "policy",
        reason: "project_trusted",
        detail: { folder: "/real/lanes/a", inheritedFrom: "/w/api" },
      },
    ]);
    expect(restarts).toEqual([]);
  });

  it("inherit names a token as the actor of its audit row", async () => {
    const { port, audit } = bed(trustedSource({ ok: true, folder: "/real/lanes/a" }));
    expect(await port.inherit("u1", "/lanes/a", "/w/api", { kind: "token", credentialId: "tok-1" })).toBe(
      true,
    );
    expect(audit[0]).toMatchObject({ actor: "token", actorId: "tok-1", reason: "project_trusted" });
  });

  it("inherit answers false, with no audit, when the helper refuses or fails", async () => {
    const refused = bed(trustedSource({ ok: false, refusal: "holds-other-projects" }));
    expect(await refused.port.inherit("u1", "/lanes/a", "/w/api")).toBe(false);
    expect(refused.audit).toEqual([]);
    const failing = bed((op) => {
      if (op === "trust.set") throw new Error("helper down");
      return status(true);
    });
    expect(await failing.port.inherit("u1", "/lanes/a", "/w/api")).toBe(false);
    expect(failing.audit).toEqual([]);
    expect(failing.lines.some((line) => line.msg === "trust_port_inherit_failed")).toBe(true);
  });

  it("inherit writes nothing when the source project is revoked before the queue turn (T6a-3)", async () => {
    const { port, calls, audit } = bed((op) =>
      op === "trust.status" ? status(null) : { ok: true, folder: "/x" },
    );
    expect(await port.inherit("u1", "/lanes/a", "/w/api")).toBe(false);
    expect(calls.map((call) => call.op)).toEqual(["trust.status"]);
    expect(audit).toEqual([]);
  });

  it("clear removes the decision and audits project_trust_cleared", async () => {
    const { port, calls, audit } = bed(() => ({ ok: true, folder: "/lanes/a" }));
    await port.clear("u1", "/lanes/a");
    expect(calls[0]).toMatchObject({ op: "trust.set", params: { decision: null } });
    expect(audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "policy",
        reason: "project_trust_cleared",
        detail: { folder: "/lanes/a" },
      },
    ]);
  });

  it("clear throws helper_failed when the helper does not record it, and audits nothing", async () => {
    const { port, audit } = bed(() => ({ ok: false, refusal: "holds-other-projects" }));
    await expect(port.clear("u1", "/lanes/a")).rejects.toMatchObject({ code: "helper_failed" });
    expect(audit).toEqual([]);
  });
});
