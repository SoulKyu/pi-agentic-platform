import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../open-home.ts";
import { fakeSystemd } from "../testing/fake-systemd.ts";
import { cliIo } from "../testing/cli-io.ts";
import { unitFilePath } from "./common.ts";
import { createSystemd } from "./systemd.ts";

let dir: string;
let fake: ReturnType<typeof fakeSystemd>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-systemd-m6b-"));
  fake = fakeSystemd(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const env = () => ({ PATH: `${fake.binDir}:/usr/bin:/bin`, HOME: dir });
const ID = "0123456789abcdef0123456789abcdef";
const SINCE = "2026-10-15 12:00:00 UTC";

describe("activeState", () => {
  it("reads the state with the exact argv and is null for garbage or a failure", async () => {
    const systemd = createSystemd(env());
    fake.set("active-state", "active\n");
    expect(await systemd.activeState("pap.service")).toBe("active");
    fake.set("active-state", "failed\n");
    expect(await systemd.activeState("pap.service")).toBe("failed");
    fake.set("active-state", "Active; rm -rf\n");
    expect(await systemd.activeState("pap.service")).toBeNull();
    fake.set("active-state", "active\n");
    fake.set("fail-show", "");
    expect(await systemd.activeState("pap.service")).toBeNull();
    expect(fake.calls()[0]).toBe("systemctl --user show -p ActiveState --value pap.service");
  });
});

describe("restartCount", () => {
  it("reads NRestarts with the exact argv and is null for garbage", async () => {
    const systemd = createSystemd(env());
    fake.set("restart-count", "3\n");
    expect(await systemd.restartCount("pap-preview.service")).toBe(3);
    fake.set("restart-count", "many\n");
    expect(await systemd.restartCount("pap-preview.service")).toBeNull();
    fake.set("restart-count", "1234567\n");
    expect(await systemd.restartCount("pap-preview.service")).toBeNull();
    expect(fake.calls()[0]).toBe("systemctl --user show -p NRestarts --value pap-preview.service");
  });
});

describe("cat", () => {
  it("returns the effective unit text with the exact argv", async () => {
    fake.set("cat-unit", "[Service]\nExecStart=/x\n");
    expect(await createSystemd(env()).cat("pap.service")).toBe("[Service]\nExecStart=/x\n");
    expect(fake.calls()).toEqual(["systemctl --user cat pap.service"]);
  });
  it("answers per unit name, and a unit with no answer fails like an uninstalled one", async () => {
    fake.set("cat-unit@pap-preview.service", "[Service]\nExecStart=/preview\n");
    const systemd = createSystemd(env());
    expect(await systemd.cat("pap-preview.service")).toBe("[Service]\nExecStart=/preview\n");
    await expect(systemd.cat("pap.service")).rejects.toThrow("systemctl cat failed (exit 1)");
  });
  it("refuses a unit text above 64 KiB instead of cutting it (a cut text could hide the line that matters)", async () => {
    fake.set("cat-unit", "a".repeat(65_536));
    expect((await createSystemd(env()).cat("pap.service")).length).toBe(65_536);
    fake.set("cat-unit", "a".repeat(65_537));
    await expect(createSystemd(env()).cat("pap.service")).rejects.toThrow(/larger than 64 KiB/);
  });
  it("a failure is a fixed CliError without the stderr", async () => {
    fake.set("fail-cat", "");
    const error = await createSystemd(env())
      .cat("pap.service")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe("systemctl cat failed (exit 1)");
  });
  it.each(["x; y", "../x", "pap", "-x.service", ""])("refuses the unit %j before any spawn", async (unit) => {
    const systemd = createSystemd(env());
    await expect(systemd.cat(unit)).rejects.toBeInstanceOf(CliError);
    await expect(systemd.activeState(unit)).rejects.toBeInstanceOf(CliError);
    await expect(systemd.restartCount(unit)).rejects.toBeInstanceOf(CliError);
    expect(fake.calls()).toEqual([]);
  });
});

describe("the unit option threads through the journal reads", () => {
  it("with unit pap-preview.service the reads select that unit and not pap.service", async () => {
    fake.set("journal", "from-preview\n");
    fake.set("journal-any", "preview manager line\n");
    const systemd = createSystemd(env(), { unit: "pap-preview.service" });
    expect(await systemd.journal(ID, SINCE, false)).toBe("from-preview\n");
    expect(await systemd.journalAny(SINCE)).toBe("preview manager line\n");
    const calls = fake.calls();
    expect(calls).toEqual([
      `journalctl --user -q -u pap-preview.service _SYSTEMD_USER_UNIT=pap-preview.service _SYSTEMD_INVOCATION_ID=${ID} -o cat --no-pager -n 200`,
      `journalctl --user -q -u pap-preview.service --since ${SINCE} -o cat --no-pager -n 20`,
    ]);
    expect(calls.join("\n")).not.toContain("pap.service");
  });
  it("without the option the unit is pap.service", async () => {
    fake.set("journal", "x\n");
    await createSystemd(env()).journal(ID, SINCE, false);
    expect(fake.calls()[0]).toContain("-u pap.service _SYSTEMD_USER_UNIT=pap.service");
  });
  it("a bad unit option is refused when the client is made", () => {
    expect(() => createSystemd(env(), { unit: "x; y" })).toThrow(CliError);
  });
});

describe("unitFilePath takes the unit", () => {
  it("defaults to pap.service and names another unit", () => {
    const { io } = cliIo({ homedir: "/home/u" });
    expect(unitFilePath(io)).toBe("/home/u/.config/systemd/user/pap.service");
    expect(unitFilePath(io, "pap-preview.service")).toBe("/home/u/.config/systemd/user/pap-preview.service");
  });
});
