import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEMPLATE, current, hasCurrent, installBed, makeRoot, releases } from "./archive-install-bed.ts";

const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

describe("archive installer recovery", () => {
  it("I1: the rollback runs reset-failed before it restarts the previous release", () => {
    const root = makeRoot();
    expect(installBed("r1", root).run().status).toBe(0);
    const before = lines(root.sysLog).length;
    const result = installBed("r2", root).run({ env: { NODE_EXIT: "1" } });
    expect(result.status).toBe(1);
    const log = lines(root.sysLog).slice(before);
    const reset = log.indexOf("--user reset-failed pap.service");
    expect(reset).toBeGreaterThan(-1);
    expect(log.indexOf("--user restart pap.service")).toBeGreaterThan(reset);
  });

  it("I1: a refused reset-failed does not stop the rollback restart", () => {
    const root = makeRoot();
    expect(installBed("r1", root).run().status).toBe(0);
    const result = installBed("r2", root).run({ env: { NODE_EXIT: "1", RESET_FAILS: "1" } });
    expect(result.stderr).toContain(
      "the previous release (r1) is back in place and the service was restarted",
    );
  });

  it("I2: exit code 3 from service install is 'installed, unverified': no rollback, current stays", () => {
    const root = makeRoot();
    const r1 = installBed("r1", root);
    expect(r1.run().status).toBe(0);
    const before = lines(root.sysLog).length;
    const r2 = installBed("r2", root);
    const result = r2.run({ env: { NODE_EXIT: "3" } });
    expect(result.status).toBe(3);
    expect(current(r2.app)).toBe("releases/r2");
    expect(
      lines(root.sysLog)
        .slice(before)
        .some((l) => l.includes("restart")),
    ).toBe(false);
    expect(result.stdout).toContain("installed but NOT verified");
    expect(result.stdout).toContain("systemctl --user status pap");
    expect(result.stderr).not.toContain("is back in place");
    expect(releases(r2.app)).toEqual(["r1", "r2"]);
  });

  it("I2: a first install with exit code 3 keeps current", () => {
    const bed = installBed("r1");
    const result = bed.run({ env: { NODE_EXIT: "3" } });
    expect(result.status).toBe(3);
    expect(hasCurrent(bed.app)).toBe(true);
    expect(current(bed.app)).toBe("releases/r1");
    expect(result.stdout).toContain("installed but NOT verified");
  });

  it("I2: any other failing code still rolls back", () => {
    const root = makeRoot();
    expect(installBed("r1", root).run().status).toBe(0);
    const r2 = installBed("r2", root);
    expect(r2.run({ env: { NODE_EXIT: "2" } }).status).toBe(1);
    expect(current(r2.app)).toBe("releases/r1");
  });

  it("M3: reinstalling the same release keeps the rollback target", () => {
    const root = makeRoot();
    expect(installBed("r1", root).run().status).toBe(0);
    const again = installBed("r2", root);
    expect(again.run().status).toBe(0);
    expect(again.run().status).toBe(0);
    expect(current(again.app)).toBe("releases/r2");
    expect(releases(again.app)).toEqual(["r1", "r2"]);
  });

  it("the unverified branch disarms the rollback trap before it writes anything (a failed write must not roll back)", () => {
    const text = readFileSync(TEMPLATE, "utf8");
    const branch = text.slice(text.indexOf('if [ "$unverified" = 1 ]'));
    expect(branch.indexOf("switched=0")).toBeGreaterThan(-1);
    expect(branch.indexOf("switched=0")).toBeLessThan(branch.indexOf("printf"));
  });
});
