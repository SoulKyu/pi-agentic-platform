import type { EgressHost, EgressReport } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { cleanReason, commandTaints, egressVerdict } from "./egress-taint.ts";

const TRUSTED = ["docs.trusted.test"];
const entry = (over: Partial<EgressHost> = {}): EgressHost => ({
  host: "docs.trusted.test",
  port: 443,
  kind: "connect",
  verdict: "allowed",
  ...over,
});
const report = (hosts: EgressHost[], truncated = false): EgressReport => ({
  type: "egress_report",
  id: "c1",
  hosts,
  truncated,
  up: 0,
  down: 0,
});

describe("commandTaints (M11R233)", () => {
  it("taints without a report, or with a cut one: nobody can say what the command reached", () => {
    expect(commandTaints(null, TRUSTED)).toBe(true);
    expect(commandTaints(undefined, TRUSTED)).toBe(true);
    expect(commandTaints(report([], true), TRUSTED)).toBe(true);
    expect(commandTaints(report([entry()], true), TRUSTED)).toBe(true);
  });

  it("does not taint a command that reached nothing", () => {
    expect(commandTaints(report([]), TRUSTED)).toBe(false);
    expect(commandTaints(report([]), [])).toBe(false);
  });

  it("does not taint a CONNECT to port 443 of a trusted source", () => {
    expect(commandTaints(report([entry()]), TRUSTED)).toBe(false);
  });

  it("taints a CONNECT to port 443 of a host that is not a trusted source", () => {
    expect(commandTaints(report([entry({ host: "other.test" })]), TRUSTED)).toBe(true);
    expect(commandTaints(report([entry()]), [])).toBe(true);
  });

  it("taints plain HTTP to a trusted source: anyone on the path can change it", () => {
    expect(commandTaints(report([entry({ kind: "http", port: 80 })]), TRUSTED)).toBe(true);
    expect(commandTaints(report([entry({ kind: "http", port: 443 })]), TRUSTED)).toBe(true);
  });

  it("taints a CONNECT to a trusted source on another port", () => {
    expect(commandTaints(report([entry({ port: 8443 })]), TRUSTED)).toBe(true);
  });

  it("never lets a refused connection taint: pap wrote that text", () => {
    const refused = (host: string) => entry({ host, verdict: "refused", reason: "not_listed" });
    expect(commandTaints(report([refused("untrusted.test")]), TRUSTED)).toBe(false);
    expect(commandTaints(report([refused("untrusted.test"), refused("docs.trusted.test")]), [])).toBe(false);
  });

  it("taints a trusted connection next to one untrusted allowed connection", () => {
    expect(commandTaints(report([entry(), entry({ host: "other.test" })]), TRUSTED)).toBe(true);
    expect(commandTaints(report([entry(), entry({ host: "other.test", verdict: "refused" })]), TRUSTED)).toBe(
      false,
    );
  });

  it("matches a trusted source exactly, with no wildcard and no suffix", () => {
    expect(commandTaints(report([entry({ host: "evil.docs.trusted.test" })]), TRUSTED)).toBe(true);
    expect(commandTaints(report([entry()]), ["*.trusted.test"])).toBe(true);
  });
});

describe("cleanReason", () => {
  it("says which clean case it was, for the stage 07 row", () => {
    expect(cleanReason(report([entry()]))).toBe("egress: trusted sources only");
    expect(cleanReason(report([]))).toBe("egress: no network used");
    expect(cleanReason(report([entry({ verdict: "refused", reason: "not_listed" })]))).toBe(
      "egress: no network used",
    );
  });
});

describe("egressVerdict: the stage 07 reason says what happened", () => {
  it.each([
    ["trusted only", report([entry()]), false, "egress: trusted sources only"],
    ["no network", report([]), false, "egress: no network used"],
    [
      "refused only",
      report([entry({ verdict: "refused", reason: "not_listed" })]),
      false,
      "egress: no network used",
    ],
    ["no report", undefined, true, "egress: no report"],
    ["cut", report([], true), true, "egress: report cut"],
    ["untrusted", report([entry({ host: "other.test" })]), true, "egress: untrusted host reached"],
    [
      "plain http to a trusted host",
      report([entry({ kind: "http", port: 80 })]),
      true,
      "egress: untrusted host reached",
    ],
  ])("%s", (_name, given, taints, reason) => {
    expect(egressVerdict(given, TRUSTED)).toEqual({ taints, reason });
  });
});
