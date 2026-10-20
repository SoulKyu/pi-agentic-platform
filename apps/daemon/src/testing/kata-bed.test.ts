import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyFolder, removeAgents } from "./kata-bed.ts";

// Mutants (RT-43), each run for real:
// - `emptyFolder` follows a link (no lstat): "refuses a link and deletes nothing behind it".
// - `removeAgents` swallows a failure without a line: "says which stop and delete failed".
let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "kata-bed-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("emptyFolder", () => {
  it("empties a plain folder and keeps the folder", () => {
    const home = join(work, "home");
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "x"), "1");
    emptyFolder(home);
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, "agents"))).toBe(false);
  });

  it("refuses a link and deletes nothing behind it", () => {
    const target = join(work, "precious");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "1");
    const home = join(work, "home");
    symlinkSync(target, home);
    expect(() => emptyFolder(home)).toThrow(/link/);
    expect(existsSync(join(target, "keep"))).toBe(true);
  });
});

describe("removeAgents", () => {
  it("says which stop and delete failed, and goes on", async () => {
    const asked: string[] = [];
    const lines: string[] = [];
    const vmd = {
      request: (request: { op: string; agentId?: string }) => {
        asked.push(request.op);
        if (request.op === "vm.list")
          return Promise.resolve({ vms: [{ agentId: "a-0001", taskKey: null, state: "running" }] });
        return Promise.reject(new Error("pap-vmd said no"));
      },
    };
    await removeAgents(vmd as never, ["a-0001"], (line) => lines.push(line));
    expect(asked).toEqual(["vm.list", "vm.stop", "disk.delete"]);
    expect(lines).toEqual([
      "kata bed: vm.stop of a-0001 failed: pap-vmd said no",
      "kata bed: disk.delete of a-0001 failed: pap-vmd said no",
    ]);
  });
});
