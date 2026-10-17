import { describe, expect, it } from "vitest";
import { cliIo } from "../testing/cli-io.ts";
import { reportRollback } from "./rollback-report.ts";

const report = { unit: "pap.service", done: "recovered", restoredSince: "10:00", kept: null };

describe("reportRollback", () => {
  it("an outcome rollback() never returns fails closed with exit 5", () => {
    const { io, stderr } = cliIo();
    const code = reportRollback(io, { kind: "updated", snapshot: null }, report);
    expect(code).toBe(5);
    expect(stderr()).toContain("unexpected");
  });

  it("says no database was kept when nothing was kept, instead of naming a file", () => {
    const { io, stdout } = cliIo();
    reportRollback(io, { kind: "rolled_back", reason: "r", restoredDatabase: true }, report);
    expect(stdout()).toContain("no copy of the replaced database was kept");
    expect(stdout()).not.toContain("pre-rollback");
  });

  it("names the real file the rollback kept, never a placeholder, and does not claim a turn ran", () => {
    const { io, stdout } = cliIo();
    const keptDatabase = "/h/.pap/backups/pre-rollback-2026-10-17T10-00-00-000Z.db";
    const code = reportRollback(
      io,
      { kind: "rolled_back", reason: "r", restoredDatabase: true, keptDatabase },
      report,
    );
    expect(code).toBe(0);
    expect(stdout()).toContain(`kept as ${keptDatabase}:`);
    expect(stdout()).not.toContain("<stamp>");
    expect(stdout()).toContain("any running turn was interrupted");
    expect(stdout()).not.toContain("running turns were interrupted");
  });
});
