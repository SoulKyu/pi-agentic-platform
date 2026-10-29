import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pushReadiness } from "../../kernel/push-readiness.ts";
import { ctx, unitWith } from "../testing/doctor-fixture.ts";
import { ALL_CHECKS } from "./registry.ts";

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
      "update_available",
      "preview.listener",
      "vm.kvm",
      "vm.vmd",
      "vm.stack",
      "vm.network",
      "vm.images",
      "vm.disk",
      "vm.listeners",
      "vm.firewall",
      "vm.bundle",
      "vm.hostMade",
      "vm.runtimeVar",
    ]);
  });

  it("every id has a row in the table of docs/agents/doctor.md", () => {
    const doc = readFileSync(new URL("../../../../../docs/agents/doctor.md", import.meta.url), "utf8");
    const rows = new Set([...doc.matchAll(/^\| `([A-Za-z0-9_.]+)` \|/gm)].map((m) => m[1]));
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
