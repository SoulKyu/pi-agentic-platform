import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SandboxProbe } from "../../kernel/sandbox/probe.ts";
import { pushReadiness } from "../../kernel/push-readiness.ts";
import { makeDoctorCommand } from "../doctor.ts";
import { ctx, unitWith } from "../testing/doctor-fixture.ts";
import { runCmd } from "../testing/update-feed.ts";
import { ALL_CHECKS } from "./registry.ts";

const probe = vi.hoisted(() => vi.fn<() => Promise<SandboxProbe>>());
vi.mock("../../kernel/sandbox/probe.ts", async (original) => ({
  ...(await original<typeof import("../../kernel/sandbox/probe.ts")>()),
  probeSandbox: probe,
}));

describe("ALL_CHECKS", () => {
  it("ids are unique and the order is the documented one", () => {
    const ids = ALL_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "node",
      "toolchain",
      "user_manager",
      "linger",
      "journal",
      "disk",
      "home",
      "schema",
      "update_pending",
      "backup",
      "https",
      "push",
      "bwrap",
      "python3",
      "update_available",
      "vm.kvm",
      "vm.vmd",
      "vm.stack",
      "vm.network",
      "vm.images",
      "vm.disk",
      "vm.firewall",
    ]);
  });

  it("every id has a row in the table of docs/agents/doctor.md", () => {
    const doc = readFileSync(new URL("../../../../../docs/agents/doctor.md", import.meta.url), "utf8");
    const rows = new Set([...doc.matchAll(/^\| `([a-z0-9_.]+)` \|/gm)].map((m) => m[1]));
    const missing = ALL_CHECKS.map((c) => c.id).filter((id) => !rows.has(id));
    expect(missing).toEqual([]);
  });

  it("every check has a title", () => {
    expect(ALL_CHECKS.every((c) => c.title.length > 0)).toBe(true);
  });
});

describe("https and push against M12's real pushReadiness", () => {
  const byId = (id: string) => ALL_CHECKS.find((c) => c.id === id);
  // [PAP_PUBLIC_ORIGIN of the unit, tls, the status pushReadiness gives, the status `https` shows, the status `push` shows]
  it.each([
    ["https://pap.example.net", false, "ready", "ok", "ok"],
    ["http://localhost:7777", false, "localhost_only", "info", "info"],
    ["http://192.0.2.10:7777", false, "insecure_http", "warn", "warn"],
    ["http://pap.example.net", true, "origin_mismatch", "warn", "warn"],
  ] as const)("%s (tls %s): %s", async (origin, tls, readiness, https, push) => {
    const unit = unitWith({ env: { PAP_PUBLIC_ORIGIN: origin }, tls });
    expect(pushReadiness({ publicOrigin: origin, tls, insecureHttp: false }).status).toBe(readiness);
    const context = ctx({ unit });
    expect((await byId("https")?.run(context))?.status).toBe(https);
    expect((await byId("push")?.run(context))?.status).toBe(push);
  });
});

describe("pap doctor --only bwrap (the form T12's container entrypoint calls)", () => {
  const command = () => makeDoctorCommand({ unitText: async () => null, inContainer: () => true });

  it("runs the registered bwrap check and returns its verdict exactly (the sandbox probe is replaced)", async () => {
    probe.mockResolvedValueOnce({ usable: false, reason: "refused" });
    const r = await runCmd(command(), ["--only", "bwrap"], { homedir: "/nonexistent-home" });
    expect(r.code).toBe(2);
    expect(r.out.split("\n").slice(2)).toEqual([
      "[warn] bwrap bubblewrap is present but the sandbox probe failed: agents that require the sandbox cannot start",
      "  fix: start the container with `--security-opt systempaths=unconfined` (scripts/pap-container.sh run); on Ubuntu also check `kernel.apparmor_restrict_unprivileged_userns`",
      "",
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a usable probe is exit 0, and an unknown id is still 64", async () => {
    probe.mockResolvedValueOnce({ usable: true, path: "/usr/bin/bwrap" });
    const ok = await runCmd(command(), ["--only", "bwrap"], { homedir: "/nonexistent-home" });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("[ok] bwrap bubblewrap works (/usr/bin/bwrap)");
    expect((await runCmd(command(), ["--only", "nope"], { homedir: "/nonexistent-home" })).code).toBe(64);
  });
});
