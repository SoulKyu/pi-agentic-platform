import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ctx, home, unitWith } from "../testing/doctor-fixture.ts";
import {
  defaultPushProbes,
  makeHttpsCheck,
  makePushCheck,
  type Readiness,
  type PushProbes,
} from "./checks-push.ts";
import type { ListenFacts } from "./listen-facts.ts";

const READY: Readiness = () => ({ status: "ready" });
const fixed =
  (status: ReturnType<Readiness>["status"], hint?: string): Readiness =>
  () => ({ status, ...(hint === undefined ? {} : { hint }) });

const keyFile = () => join(home, "secrets", "push", "vapid.json");
const keyDir = () => join(home, "secrets", "push");

function plant(fileMode: number, dirMode: number): void {
  mkdirSync(keyDir(), { recursive: true });
  writeFileSync(keyFile(), "{}");
  chmodSync(keyFile(), fileMode);
  chmodSync(keyDir(), dirMode);
}

describe("https", () => {
  it.each([
    ["ready", "ok"],
    ["localhost_only", "info"],
    ["insecure_http", "warn"],
    ["origin_mismatch", "warn"],
    ["keys_unreadable", "ok"],
  ] as const)("readiness %s is %s", async (readiness, status) => {
    const result = await makeHttpsCheck(fixed(readiness)).run(ctx());
    expect(result.status).toBe(status);
  });

  it("never fails, whatever the readiness says", async () => {
    for (const s of [
      "ready",
      "localhost_only",
      "insecure_http",
      "origin_mismatch",
      "keys_unreadable",
    ] as const)
      expect((await makeHttpsCheck(fixed(s)).run(ctx())).status).not.toBe("fail");
  });

  it("the localhost sentence and a fix that names the doc anchor and the routes in M12's order", async () => {
    const result = await makeHttpsCheck(fixed("localhost_only")).run(ctx());
    expect(result.detail).toContain("http://localhost works on this machine only");
    expect(result.detail).toContain("push notifications and the installable app need HTTPS");
    const fix = result.fix ?? "";
    expect(fix).toContain("docs/agents/notifications.md#https");
    const order = ["ngrok", "tailscale serve", "PAP_PUBLIC_ORIGIN", "--tls-cert"].map((word) =>
      fix.indexOf(word),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("each piece of the fix is printed once: the anchor and the routes", async () => {
    const hint =
      "Use an HTTPS origin: ngrok, Tailscale serve, or a reverse proxy, each through PAP_PUBLIC_ORIGIN; or --tls-cert/--tls-key.";
    for (const fix of [
      (await makeHttpsCheck(fixed("insecure_http", hint)).run(ctx())).fix ?? "",
      (await makeHttpsCheck(fixed("insecure_http")).run(ctx())).fix ?? "",
    ]) {
      expect(fix.split("docs/agents/notifications.md#https")).toHaveLength(2);
      expect(fix.split("ngrok")).toHaveLength(2);
    }
  });

  it("the push line points at the anchor and does not repeat the routes", async () => {
    const hint = "Use an HTTPS origin: ngrok, Tailscale serve.";
    for (const status of ["localhost_only", "insecure_http"] as const) {
      const fix = (await makePushCheck(fixed(status, hint)).run(ctx())).fix ?? "";
      expect(fix).toBe("docs/agents/notifications.md#https");
    }
  });

  it("an unreadable unit is info on both lines, and the readiness is never asked", async () => {
    const spy: Readiness = () => {
      throw new Error("asked");
    };
    const unreadable = ctx({ unitUnreadable: true, unitName: "pap-preview.service" });
    for (const check of [makeHttpsCheck(spy), makePushCheck(spy)]) {
      const result = await check.run(unreadable);
      expect(result.status).toBe("info");
      expect(result.detail).toBe("cannot read the listen flags of pap-preview.service");
      expect(result.detail).not.toContain("localhost");
    }
  });

  it("ok has no fix; the readiness hint rides on a warning", async () => {
    expect((await makeHttpsCheck(READY).run(ctx())).fix).toBeUndefined();
    const warn = await makeHttpsCheck(fixed("origin_mismatch", "the origin says pap.example")).run(ctx());
    expect(warn.fix).toContain("the origin says pap.example");
  });

  it("hands the readiness the facts of the unit and the environment", async () => {
    const seen: ListenFacts[] = [];
    const spy: Readiness = (facts) => {
      seen.push(facts);
      return { status: "ready" };
    };
    await makeHttpsCheck(spy).run(
      ctx({ unit: unitWith({ host: "192.0.2.1", port: 7791, insecureHttp: true }) }),
    );
    await makeHttpsCheck(spy).run(ctx({ unit: null, env: { PAP_PUBLIC_ORIGIN: "https://pap.example" } }));
    expect(seen).toEqual([
      { publicOrigin: "http://192.0.2.1:7791", tls: false, insecureHttp: true },
      { publicOrigin: "https://pap.example", tls: false, insecureHttp: false },
    ]);
  });
});

describe("push: readiness table", () => {
  it.each([
    ["ready", "ok"],
    ["localhost_only", "info"],
    ["insecure_http", "warn"],
    ["origin_mismatch", "warn"],
    ["keys_unreadable", "warn"],
  ] as const)("readiness %s with no key file is %s", async (readiness, status) => {
    const result = await makePushCheck(fixed(readiness)).run(ctx());
    expect(result.status).toBe(status);
    if (status === "warn") expect(result.detail).toContain(`push is off (${readiness})`);
  });
});

describe("push: the key file (lstat only, M12's predicate)", () => {
  it("absent file: ok, created at the first start, and nothing is created", async () => {
    const result = await makePushCheck(READY).run(ctx());
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("created at the first start");
    expect(existsSync(home)).toBe(false);
  });

  it("a regular file 0600 in a folder 0700 owned by this user is ok", async () => {
    plant(0o600, 0o700);
    expect((await makePushCheck(READY).run(ctx())).status).toBe("ok");
  });

  it.each([
    ["a file of mode 0644", 0o644, 0o700],
    ["a file of mode 0640", 0o640, 0o700],
    ["a file of mode 0400", 0o400, 0o700],
    ["a folder of mode 0750", 0o600, 0o750],
    ["a folder of mode 0755", 0o600, 0o755],
  ])("%s warns keys_unreadable with the chmod fix", async (_name, fileMode, dirMode) => {
    plant(fileMode, dirMode);
    const result = await makePushCheck(READY).run(ctx());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("push is off (keys_unreadable)");
    expect(result.fix).toContain("chmod 600");
    expect(result.fix).toContain("delete the file to start over (each device re-enables)");
  });

  it("a symlink in place of the file warns (lstat, never stat)", async () => {
    mkdirSync(keyDir(), { recursive: true, mode: 0o700 });
    chmodSync(keyDir(), 0o700);
    writeFileSync(join(home, "real.json"), "{}", { mode: 0o600 });
    symlinkSync(join(home, "real.json"), keyFile());
    expect((await makePushCheck(READY).run(ctx())).status).toBe("warn");
  });

  it("a symlink in place of the folder warns", async () => {
    mkdirSync(join(home, "secrets"), { recursive: true });
    mkdirSync(join(home, "elsewhere"), { mode: 0o700 });
    chmodSync(join(home, "elsewhere"), 0o700);
    writeFileSync(join(home, "elsewhere", "vapid.json"), "{}", { mode: 0o600 });
    symlinkSync(join(home, "elsewhere"), keyDir());
    expect((await makePushCheck(READY).run(ctx())).status).toBe("warn");
  });

  it("a directory in place of the file warns", async () => {
    mkdirSync(keyFile(), { recursive: true });
    chmodSync(keyDir(), 0o700);
    expect((await makePushCheck(READY).run(ctx())).status).toBe("warn");
  });

  it("a file owned by another user warns, even at the right mode (injected uid)", async () => {
    plant(0o600, 0o700);
    const probes: PushProbes = { ...defaultPushProbes(), uid: (process.getuid?.() ?? 0) + 1 };
    expect((await makePushCheck(READY, probes).run(ctx())).status).toBe("warn");
  });

  it("a folder owned by another user warns", async () => {
    plant(0o600, 0o700);
    const real = defaultPushProbes();
    const probes: PushProbes = {
      ...real,
      lstat: (path) => {
        const found = real.lstat(path);
        return found !== null && path === keyDir() ? { ...found, uid: found.uid + 1 } : found;
      },
    };
    expect((await makePushCheck(READY, probes).run(ctx())).status).toBe("warn");
  });

  it("the worst of readiness and key file wins, and both reasons show", async () => {
    plant(0o644, 0o700);
    const result = await makePushCheck(fixed("localhost_only")).run(ctx());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("keys_unreadable");
    const both = await makePushCheck(fixed("insecure_http")).run(ctx());
    expect(both.detail).toContain("insecure_http");
    expect(both.detail).toContain("keys_unreadable");
  });

  it("never fails", async () => {
    plant(0o777, 0o777);
    expect((await makePushCheck(fixed("origin_mismatch")).run(ctx())).status).not.toBe("fail");
  });
});
