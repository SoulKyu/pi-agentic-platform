import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../open-home.ts";
import { fakeSystemd } from "../testing/fake-systemd.ts";
import { createSystemd } from "./systemd.ts";

let dir: string;
let fake: ReturnType<typeof fakeSystemd>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-systemd-"));
  fake = fakeSystemd(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = () => ({ PATH: `${fake.binDir}:/usr/bin:/bin`, HOME: dir, OPENAI_API_KEY: "sk-secret" });
const ID = "0123456789abcdef0123456789abcdef";
const SINCE = "2026-10-15 12:00:00 UTC";

describe("userManagerUp and linger", () => {
  it("userManagerUp follows the exit code of show-environment", async () => {
    expect(await createSystemd(env()).userManagerUp()).toBe(true);
    fake.set("fail-show-environment", "");
    expect(await createSystemd(env()).userManagerUp()).toBe(false);
    expect(fake.calls()).toEqual(["systemctl --user show-environment", "systemctl --user show-environment"]);
  });
  it("lingerEnabled reads yes or no with the exact command", async () => {
    fake.set("linger", "yes\n");
    expect(await createSystemd(env()).lingerEnabled(1000)).toBe(true);
    fake.set("linger", "no\n");
    expect(await createSystemd(env()).lingerEnabled(1000)).toBe(false);
    expect(fake.calls()[0]).toBe("loginctl show-user 1000 --property=Linger --value");
  });
  it("enableLinger is true on exit 0, false on a refusal and false on a hang", async () => {
    expect(await createSystemd(env()).enableLinger()).toBe(true);
    fake.set("fail-enable-linger", "");
    expect(await createSystemd(env()).enableLinger()).toBe(false);
    rmSync(join(dir, "answers", "fail-enable-linger"));
    fake.set("hang-enable-linger", "");
    expect(await createSystemd(env(), { timeoutMs: 300 }).enableLinger()).toBe(false);
  });
  it("enableLinger is false, not a throw, when the binary is missing", async () => {
    expect(await createSystemd({ PATH: "" }).enableLinger()).toBe(false);
  });
});

describe("journal", () => {
  it.each(["", "abc", ID.toUpperCase(), `${ID}0`, `${ID.slice(1)}g`, `${ID} -f`])(
    "refuses the id %j without spawning",
    async (id) => {
      await expect(createSystemd(env()).journal(id, SINCE, true)).rejects.toBeInstanceOf(CliError);
      expect(fake.calls()).toEqual([]);
    },
  );
  it.each([
    "2026-10-15",
    "2026-10-15 12:00:00",
    "2026-10-15 12:00:00 UTC; id",
    "x2026-10-15 12:00:00 UTC",
    "--since",
  ])("refuses the since value %j without spawning", async (since) => {
    await expect(createSystemd(env()).journal(ID, since, true)).rejects.toBeInstanceOf(CliError);
    expect(fake.calls()).toEqual([]);
  });
  it("matches on the invocation id first", async () => {
    fake.set("journal", "from-id\n");
    expect(await createSystemd(env()).journal(ID, SINCE, true)).toBe("from-id\n");
    expect(fake.calls()).toEqual([
      `journalctl --user -q -u pap.service _SYSTEMD_USER_UNIT=pap.service _SYSTEMD_INVOCATION_ID=${ID} -o cat --no-pager -n 200`,
    ]);
  });
  it("falls back to --since when the match is empty", async () => {
    fake.set("journal-since", "from-since\n");
    expect(await createSystemd(env()).journal(ID, SINCE, true)).toBe("from-since\n");
    expect(fake.calls()).toEqual([
      `journalctl --user -q -u pap.service _SYSTEMD_USER_UNIT=pap.service _SYSTEMD_INVOCATION_ID=${ID} -o cat --no-pager -n 200`,
      "journalctl --user -q -u pap.service _SYSTEMD_USER_UNIT=pap.service --since 2026-10-15 12:00:00 UTC -o cat --no-pager -n 200",
    ]);
  });
});

describe("journal fallback and unmatched query", () => {
  it("never runs --since when the fallback is off (M1b)", async () => {
    fake.set("journal-since", "stale\n");
    expect(await createSystemd(env()).journal(ID, SINCE, false)).toBe("");
    expect(fake.calls()).toHaveLength(1);
    expect(fake.calls()[0]).not.toContain("--since");
  });
  it("journalAny asks for pap.service since the restart without the user-unit match", async () => {
    fake.set("journal-any", "Started pap.service.\n");
    expect(await createSystemd(env()).journalAny(SINCE)).toBe("Started pap.service.\n");
    expect(fake.calls()).toEqual([
      "journalctl --user -q -u pap.service --since 2026-10-15 12:00:00 UTC -o cat --no-pager -n 20",
    ]);
  });
  it("journalAny refuses a malformed since value without spawning", async () => {
    await expect(createSystemd(env()).journalAny("--since")).rejects.toBeInstanceOf(CliError);
    expect(fake.calls()).toEqual([]);
  });
  it("a failing journalctl names the read, not its first option (M7)", async () => {
    fake.set("fail-journal", "");
    await expect(createSystemd(env()).journal(ID, SINCE, true)).rejects.toThrow(
      "journalctl read failed (exit 1)",
    );
  });
});

describe("resetFailed", () => {
  it("runs systemctl --user reset-failed and ignores a refusal", async () => {
    const systemd = createSystemd(env());
    await systemd.resetFailed("pap.service");
    fake.set("fail-reset-failed", "");
    await systemd.resetFailed("pap.service");
    expect(fake.calls()).toEqual([
      "systemctl --user reset-failed pap.service",
      "systemctl --user reset-failed pap.service",
    ]);
  });
  it("still refuses a bad unit name and ignores a missing binary", async () => {
    await expect(createSystemd(env()).resetFailed("x; y")).rejects.toBeInstanceOf(CliError);
    await expect(createSystemd({ PATH: "" }).resetFailed("pap.service")).resolves.toBeUndefined();
  });
});

describe("journal trust and argument shape", () => {
  it("never takes a line that matches only the client-settable USER_UNIT field", async () => {
    fake.set("journal-untrusted", "forged setup_url\n");
    expect(await createSystemd(env()).journal(ID, SINCE, true)).toBe("");
  });
  it("passes the since time as one argument", async () => {
    fake.set("journal-since", "x\n");
    await createSystemd(env()).journal(ID, SINCE, true);
    // journalctl --user -q -u pap.service <unit match> --since <date> -o cat --no-pager -n 200 (11 arguments, then 12: a split date would give 14)
    expect(fake.argcs()).toEqual(["journalctl 11", "journalctl 12"]);
  });
});

describe("invocationId, isActive, unit verbs", () => {
  it("invocationId returns a valid id and null otherwise", async () => {
    fake.set("invocation-id", `${ID}\n`);
    expect(await createSystemd(env()).invocationId("pap.service")).toBe(ID);
    fake.set("invocation-id", "not-an-id\n");
    expect(await createSystemd(env()).invocationId("pap.service")).toBeNull();
    expect(fake.calls()[0]).toBe("systemctl --user show -p InvocationID --value pap.service");
  });
  it("isActive follows the exit code and the verbs run the documented commands", async () => {
    const systemd = createSystemd(env());
    expect(await systemd.isActive("pap.service")).toBe(true);
    fake.set("active", "no");
    expect(await systemd.isActive("pap.service")).toBe(false);
    await systemd.daemonReload();
    expect(await systemd.isEnabled("pap.service")).toBe(false);
    await systemd.enable("pap.service");
    expect(await systemd.isEnabled("pap.service")).toBe(true);
    await systemd.restart("pap.service");
    await systemd.stop("pap.service");
    await systemd.disable("pap.service");
    expect(fake.calls()).toEqual([
      "systemctl --user is-active --quiet pap.service",
      "systemctl --user is-active --quiet pap.service",
      "systemctl --user daemon-reload",
      "systemctl --user is-enabled --quiet pap.service",
      "systemctl --user enable pap.service",
      "systemctl --user is-enabled --quiet pap.service",
      "systemctl --user restart pap.service",
      "systemctl --user stop pap.service",
      "systemctl --user disable pap.service",
    ]);
  });
  it.each(["pap.service; rm -rf x", "../x", "pap", "Pap.service", "-x.service", ""])(
    "refuses the unit name %j before any spawn",
    async (unit) => {
      const systemd = createSystemd(env());
      for (const call of [
        systemd.restart,
        systemd.enable,
        systemd.stop,
        systemd.disable,
        systemd.isActive,
        systemd.invocationId,
      ])
        await expect(call(unit)).rejects.toBeInstanceOf(CliError);
      expect(fake.calls()).toEqual([]);
    },
  );
});

describe("loadState and activeSince", () => {
  it("loadState reads the state with the exact command and is null on garbage", async () => {
    fake.set("load-state", "not-found\n");
    expect(await createSystemd(env()).loadState("pap.service")).toBe("not-found");
    fake.set("load-state", "x; rm\n");
    expect(await createSystemd(env()).loadState("pap.service")).toBeNull();
    expect(fake.calls()[0]).toBe("systemctl --user show -p LoadState --value pap.service");
  });
  it("activeSince returns the UTC time of the current start and null otherwise", async () => {
    fake.set("active-enter", "Thu 2026-10-15 18:20:11 UTC\n");
    expect(await createSystemd(env()).activeSince("pap.service")).toBe("2026-10-15 18:20:11 UTC");
    expect(fake.calls()[0]).toBe(
      "systemctl --user show --timestamp=utc -p ActiveEnterTimestamp --value pap.service",
    );
    fake.set("active-enter", "\n");
    expect(await createSystemd(env()).activeSince("pap.service")).toBeNull();
    fake.set("active-enter", "Thu 2026-10-15 18:20:11 CEST\n");
    expect(await createSystemd(env()).activeSince("pap.service")).toBeNull();
  });
});

describe("failure reporting and child environment", () => {
  it("a failing verb throws a fixed sentence without the child's stderr", async () => {
    fake.set("fail-restart", "");
    const error = await createSystemd(env())
      .restart("pap.service")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe("systemctl restart failed (exit 1)");
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).not.toContain("SECRET-STDERR");
  });
  it("a timeout says so", async () => {
    fake.set("hang-restart", "");
    await expect(createSystemd(env(), { timeoutMs: 300 }).restart("pap.service")).rejects.toThrow(
      "systemctl timed out",
    );
  });
  it("output over the buffer cap is reported as such, not as a timeout", async () => {
    fake.set("flood-restart", "");
    await expect(createSystemd(env()).restart("pap.service")).rejects.toThrow("systemctl output too large");
  });
  it.each([-1, 1.5, Number.NaN])("lingerEnabled refuses the uid %s without spawning", async (uid) => {
    await expect(createSystemd(env()).lingerEnabled(uid)).rejects.toBeInstanceOf(CliError);
    expect(fake.calls()).toEqual([]);
  });
  it("a missing binary throws a fixed sentence", async () => {
    await expect(createSystemd({ PATH: "" }).restart("pap.service")).rejects.toThrow(
      "systemctl could not be run",
    );
  });
  it("passes only the five allowed variables to the child", async () => {
    await createSystemd({
      ...env(),
      XDG_RUNTIME_DIR: "/run/user/1",
      LANG: "C",
      LD_PRELOAD: "x",
    }).daemonReload();
    const keys = fake.envKeys();
    for (const secret of ["OPENAI_API_KEY", "LD_PRELOAD"]) expect(keys).not.toContain(secret);
    for (const key of ["PATH", "HOME", "XDG_RUNTIME_DIR", "LANG"]) expect(keys).toContain(key);
    const shellOwn = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
    const allowed = new Set(["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"]);
    expect(keys.filter((key) => !allowed.has(key) && !shellOwn.has(key))).toEqual([]);
  });
});
