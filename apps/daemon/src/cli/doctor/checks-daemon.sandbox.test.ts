import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { SandboxProbe } from "../../kernel/sandbox/probe.ts";
import { daemonProbes } from "../testing/daemon-probes.ts";
import { ctx } from "../testing/doctor-fixture.ts";
import { makeDaemonChecks, type DaemonProbes } from "./checks-daemon.ts";
import type { DoctorContext } from "./types.ts";

function run(id: string, over: Partial<DaemonProbes>, context: DoctorContext = ctx()) {
  const found = makeDaemonChecks(daemonProbes(over)).find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found.run(context);
}

const probing = (result: SandboxProbe): Partial<DaemonProbes> => ({ sandbox: async () => result });

describe("bwrap", () => {
  it("a usable probe is ok and names the binary", async () => {
    const result = await run("bwrap", probing({ usable: true, path: "/usr/bin/bwrap" }));
    expect(result).toMatchObject({ status: "ok", detail: expect.stringContaining("/usr/bin/bwrap") });
  });

  it("missing warns with the package command", async () => {
    const result = await run("bwrap", probing({ usable: false, reason: "missing" }));
    expect(result.status).toBe("warn");
    expect(result.fix).toBe("sudo apt install bubblewrap");
  });

  it("unsafe_path warns and says root-owned", async () => {
    const result = await run("bwrap", probing({ usable: false, reason: "unsafe_path" }));
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("root");
  });

  it("timeout warns", async () => {
    const result = await run("bwrap", probing({ usable: false, reason: "timeout" }));
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("did not answer");
  });

  it("refused outside a container names the AppArmor sysctl", async () => {
    const result = await run("bwrap", probing({ usable: false, reason: "refused" }));
    expect(result.status).toBe("warn");
    expect(result.fix).toContain("kernel.apparmor_restrict_unprivileged_userns");
    expect(result.fix).not.toContain("systempaths");
  });

  it("refused in a container names --security-opt systempaths=unconfined first", async () => {
    const result = await run(
      "bwrap",
      probing({ usable: false, reason: "refused" }),
      ctx({ inContainer: true }),
    );
    expect(result.status).toBe("warn");
    const fix = result.fix ?? "";
    expect(fix).toContain("--security-opt systempaths=unconfined");
    expect(fix).toContain("scripts/pap-container.sh run");
    expect(fix.indexOf("systempaths")).toBeLessThan(
      fix.indexOf("kernel.apparmor_restrict_unprivileged_userns"),
    );
  });

  it("runs the probe (a binary that exists but fails is not ok) with the context clock and the PAP_BWRAP of the unit", async () => {
    const seen: Array<{ override: string | undefined; clock: unknown }> = [];
    const clock = createFakeClock();
    const probes = {
      sandbox: async (override: string | undefined, c: DoctorContext) => {
        seen.push({ override, clock: c.clock });
        return { usable: false, reason: "refused" } as const;
      },
    };
    const unit = {
      node: "/n",
      main: "/m",
      port: null,
      host: null,
      home: null,
      tls: false,
      insecureHttp: false,
    };
    const result = await run(
      "bwrap",
      probes,
      ctx({ clock, unit: { ...unit, env: { PAP_BWRAP: "/opt/bwrap" } } }),
    );
    expect(result.status).toBe("warn");
    expect(seen).toEqual([{ override: "/opt/bwrap", clock }]);
    await run("bwrap", probes, ctx({ clock, unit: null, env: { PAP_BWRAP: "/shell/bwrap" } }));
    expect(seen[1]?.override).toBe("/shell/bwrap");
    await run("bwrap", probes, ctx({ clock, unit: null, env: { PAP_BWRAP: "relative" } }));
    expect(seen[2]?.override).toBeUndefined();
  });
});

describe("python3", () => {
  it("the first root-owned candidate is ok", async () => {
    const asked: string[] = [];
    const result = await run("python3", {
      trusted: (path) => {
        asked.push(path);
        return path === "/usr/bin/python3" ? "/usr/bin/python3.12" : null;
      },
    });
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("/usr/bin/python3.12");
    expect(asked).toEqual(["/usr/bin/python3"]);
  });

  it("falls through the three system paths, in the order M11 uses", async () => {
    const asked: string[] = [];
    await run("python3", {
      trusted: (path) => {
        asked.push(path);
        return null;
      },
    });
    expect(asked).toEqual(["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"]);
  });

  it("none trusted warns: networked agents need it", async () => {
    const result = await run("python3", { trusted: () => null });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("networked agents need it");
    expect(result.fix).toContain("python3");
  });
});
