import { describe, expect, it } from "vitest";
import { BOX_OP_RESULTS, BOX_OP_TIMEOUTS, BoxOp } from "./boxes.ts";

const view = {
  id: "a".repeat(32),
  name: "site",
  port: 8000,
  state: "running",
  reason: null,
  startedAt: 1,
  network: true,
};
const start = {
  name: "svc.start",
  service: "site",
  command: "python3 -m http.server 8000",
  port: 8000,
  network: true,
};

describe("box service ops", () => {
  it("parse strictly, the service name in `service` (`name` is the op's discriminator)", () => {
    expect(BoxOp.safeParse(start).success).toBe(true);
    expect(BoxOp.safeParse({ ...start, network: undefined }).success).toBe(false);
    expect(BoxOp.safeParse({ ...start, extra: 1 }).success).toBe(false);
    for (const op of ["svc.restart", "svc.stop", "svc.logs"]) {
      expect(BoxOp.safeParse({ name: op, service: "site" }).success, op).toBe(true);
      expect(BoxOp.safeParse({ name: op, service: "Site" }).success, op).toBe(false);
      expect(BoxOp.safeParse({ name: op }).success, op).toBe(false);
    }
    expect(BoxOp.safeParse({ name: "svc.list" }).success).toBe(true);
    expect(BoxOp.safeParse({ name: "svc.list", service: "x" }).success).toBe(false);
  });

  it("answer within their bounds", () => {
    expect(BOX_OP_RESULTS["svc.start"].safeParse(view).success).toBe(true);
    expect(BOX_OP_RESULTS["svc.restart"].safeParse(view).success).toBe(true);
    expect(BOX_OP_RESULTS["svc.stop"].safeParse({ stopped: false }).success).toBe(true);
    expect(BOX_OP_RESULTS["svc.list"].safeParse({ services: Array(4).fill(view) }).success).toBe(true);
    expect(BOX_OP_RESULTS["svc.list"].safeParse({ services: Array(5).fill(view) }).success).toBe(false);
    expect(BOX_OP_RESULTS["svc.logs"].safeParse({ lines: Array(200).fill("x".repeat(512)) }).success).toBe(
      true,
    );
    expect(BOX_OP_RESULTS["svc.logs"].safeParse({ lines: ["x".repeat(513)] }).success).toBe(false);
    expect(BOX_OP_RESULTS["svc.logs"].safeParse({ lines: Array(201).fill("x") }).success).toBe(false);
  });

  it("give start and restart 45 s and the rest 30 s", () => {
    expect(BOX_OP_TIMEOUTS["svc.start"]).toBe(45_000);
    expect(BOX_OP_TIMEOUTS["svc.restart"]).toBe(45_000);
    for (const op of ["svc.stop", "svc.list", "svc.logs"] as const)
      expect(BOX_OP_TIMEOUTS[op], op).toBe(30_000);
  });

  it("project.config carries the preview declaration and whether it was invalid", () => {
    const base = { packages: null, error: null };
    const result = BOX_OP_RESULTS["project.config"];
    expect(
      result.safeParse({ ...base, preview: { command: "npm run dev", port: 5173 }, previewInvalid: false })
        .success,
    ).toBe(true);
    expect(result.safeParse({ ...base, preview: null, previewInvalid: true }).success).toBe(true);
    expect(result.safeParse(base).success).toBe(false);
  });
});
