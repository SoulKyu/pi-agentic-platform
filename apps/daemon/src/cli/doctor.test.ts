import { describe, expect, it } from "vitest";
import { runCmd } from "./testing/update-feed.ts";
import { makeDoctorCommand } from "./doctor.ts";
import type { Check, CheckResult, DoctorContext } from "./doctor/types.ts";

const UNIT_TEXT = [
  "[Service]",
  "Environment=PAP_HOME=/srv/pap-data",
  "ExecStart=/usr/bin/node /opt/pap/main.js serve --port 7791 --insecure-http",
  "",
].join("\n");

function harness(result: CheckResult = { status: "ok", detail: "fine" }) {
  const seen: DoctorContext[] = [];
  const probe: Check = {
    id: "probe",
    title: "Probe",
    async run(ctx) {
      seen.push(ctx);
      return result;
    },
  };
  const command = (unitText: string | null, extra: { container?: boolean; lock?: boolean } = {}) =>
    makeDoctorCommand({
      checks: [probe],
      unitText: async () => unitText,
      inContainer: () => extra.container ?? false,
      lockHeld: () => extra.lock ?? false,
    });
  return { seen, command };
}

describe("pap doctor: unit and home (M6bR28)", () => {
  it("the installed unit's home wins over a PAP_HOME of this shell", async () => {
    const { seen, command } = harness();
    const r = await runCmd(command(UNIT_TEXT), [], { env: { PAP_HOME: "/shell/home" }, homedir: "/h" });
    expect(r.code).toBe(0);
    expect(seen[0]).toMatchObject({ home: "/srv/pap-data", homeSource: "unit", unitName: "pap.service" });
    expect(seen[0]?.unit?.port).toBe(7791);
    expect(r.out).toContain("unit: pap.service (installed)");
    expect(r.out).toContain("home: /srv/pap-data (from the unit)");
  });

  it("without a unit: --home, then the environment, then ~/.pap", async () => {
    const { seen, command } = harness();
    await runCmd(command(null), ["--home", "/flag/home"], {
      env: { PAP_HOME: "/shell/home" },
      homedir: "/h",
    });
    await runCmd(command(null), [], { env: { PAP_HOME: "/shell/home" }, homedir: "/h" });
    const none = await runCmd(command(null), [], { homedir: "/h" });
    expect(seen.map((c) => [c.home, c.homeSource, c.unit])).toEqual([
      ["/flag/home", "flag", null],
      ["/shell/home", "environment", null],
      ["/h/.pap", "default", null],
    ]);
    expect(none.out).toContain("unit: pap.service (not installed)");
    expect(none.out).toContain("home: /h/.pap (from the default)");
  });

  it("--home beats the unit; --unit and PAP_UNIT pick the unit, the flag first", async () => {
    const { seen, command } = harness();
    await runCmd(command(UNIT_TEXT), ["--home", "/flag/home"], { homedir: "/h" });
    await runCmd(command(UNIT_TEXT), [], { env: { PAP_UNIT: "pap-preview.service" }, homedir: "/h" });
    await runCmd(command(UNIT_TEXT), ["--unit", "pap-x.service"], {
      env: { PAP_UNIT: "pap-preview.service" },
      homedir: "/h",
    });
    expect(seen.map((c) => [c.home, c.homeSource, c.unitName])).toEqual([
      ["/flag/home", "flag", "pap.service"],
      ["/srv/pap-data", "unit", "pap-preview.service"],
      ["/srv/pap-data", "unit", "pap-x.service"],
    ]);
  });

  it("a unit pap cannot read is reported, the home falls back, and ctx.unit is null", async () => {
    const { seen, command } = harness();
    const r = await runCmd(command("[Service]\nExecStart=/bin/true\n"), [], { homedir: "/h" });
    expect(seen[0]).toMatchObject({
      unit: null,
      home: "/h/.pap",
      homeSource: "default",
      unitUnreadable: true,
    });
    expect(r.out).toContain("unit: pap.service (installed, but pap cannot read it)");
  });

  it("a hand-written unit (relative main path): https and push say the listen flags are unreadable, never localhost", async () => {
    const preview = [
      "[Service]",
      "WorkingDirectory=/srv/pap",
      "ExecStart=/usr/bin/node apps/daemon/dist/main.js serve --host 192.0.2.7 --insecure-http",
      "",
    ].join("\n");
    const command = makeDoctorCommand({
      unitText: async () => preview,
      inContainer: () => false,
      lockHeld: () => false,
    });
    const r = await runCmd(command, ["--unit", "pap-preview.service", "--only", "https,push"], {
      homedir: "/h",
    });
    expect(r.out).toContain("[info] https cannot read the listen flags of pap-preview.service");
    expect(r.out).toContain("[info] push cannot read the listen flags of pap-preview.service");
    expect(r.out).not.toContain("localhost");
    expect(r.out).toContain("fix: check --host, --tls-cert and --insecure-http of the unit by hand");
  });

  it("a missing unit is not 'unreadable'", async () => {
    const { seen, command } = harness();
    await runCmd(command(null), [], { homedir: "/h" });
    expect(seen[0]?.unitUnreadable).toBe(false);
  });

  it("passes the container and lock facts through", async () => {
    const { seen, command } = harness();
    await runCmd(command(null, { container: true, lock: true }), [], { homedir: "/h" });
    expect(seen[0]).toMatchObject({ inContainer: true, lockHeld: true });
  });

  it("a bad unit name is a usage error and nothing runs", async () => {
    const { seen, command } = harness();
    const r = await runCmd(command(null), ["--unit", "../x"], { homedir: "/h" });
    expect(r.code).toBe(64);
    expect(seen).toEqual([]);
  });
});

describe("pap doctor: output and exit", () => {
  it("--json prints one JSON object and nothing else", async () => {
    const { command } = harness({ status: "warn", detail: "d", fix: "f" });
    const r = await runCmd(command(null), ["--json"], { homedir: "/h" });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toEqual({
      exit: 2,
      results: [{ id: "probe", title: "Probe", status: "warn", detail: "d", fix: "f" }],
    });
    expect(r.err).toBe("");
  });

  it("text output has the header, the check line and the fix line; fail exits 1", async () => {
    const { command } = harness({ status: "fail", detail: "d", fix: "f" });
    const r = await runCmd(command(null), [], { homedir: "/h" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[fail] probe d\n  fix: f\n");
  });

  it("an unknown --only id is exit 64 with the known ids; a known one runs alone", async () => {
    const { seen, command } = harness();
    const bad = await runCmd(command(null), ["--only", "probe,nope"], { homedir: "/h" });
    expect(bad.code).toBe(64);
    expect(bad.err).toContain("nope");
    expect(bad.err).toContain("probe");
    expect(seen).toEqual([]);
    expect((await runCmd(command(null), ["--only", "probe"], { homedir: "/h" })).code).toBe(0);
  });

  it("takes no positional argument and prints help", async () => {
    const { command } = harness();
    expect((await runCmd(command(null), ["extra"], { homedir: "/h" })).code).toBe(64);
    const help = await runCmd(command(null), ["--help"], { homedir: "/h" });
    expect(help.out).toContain("usage: pap doctor");
  });

  it("no control character reaches the terminal through the unit and home header lines", async () => {
    const { command } = harness();
    const r = await runCmd(command(null), ["--home", "/h/\u001b[2Jx\u0007"], { homedir: "/h" });
    expect(r.out).toContain("home: /h/?[2Jx? (from the flag)");
    const controls = [...r.out].filter(
      (c) => c !== "\n" && (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f),
    );
    expect(controls).toEqual([]);
  });
});
