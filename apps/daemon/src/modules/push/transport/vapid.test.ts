import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, verify, createPublicKey } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { createLogger } from "../../../kernel/logger.ts";
import { loadVapid, type VapidState } from "./vapid.ts";

let secrets = "";
let lines: string[] = [];
const logger = () =>
  createLogger({ level: "debug", clock: createFakeClock(), write: (line) => lines.push(line) });
const pushDir = () => join(secrets, "push");
const file = () => join(pushDir(), "vapid.json");
const ready = (state: VapidState) => {
  if (state.kind !== "ready") throw new Error("expected ready");
  return state;
};
const validJson = () =>
  JSON.stringify({
    v: 1,
    privateJwk: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" }),
  });

const ownD = (key: KeyObject) => String(key.export({ format: "jwk" }).d);
const flip = (d: string) => {
  const bytes = Buffer.from(d, "base64url");
  bytes[5] = (bytes[5] ?? 0) ^ 0x01;
  return bytes.toString("base64url");
};
const withD = (change: (d: string) => string) => {
  const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
  return JSON.stringify({ v: 1, privateJwk: { ...jwk, d: change(String(jwk.d)) } });
};
const reasons = () => lines.map((l) => (JSON.parse(l) as { reason?: string }).reason);

beforeEach(() => {
  secrets = mkdtempSync(join(tmpdir(), "pap-vapid-"));
  lines = [];
});
afterEach(() => rmSync(secrets, { recursive: true, force: true }));

describe("loadVapid", () => {
  it("creates-0600-in-0700", () => {
    const state = ready(loadVapid(secrets, logger()));
    expect(state.minted).toBe(true);
    expect(statSync(pushDir()).mode & 0o777).toBe(0o700);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readdirSync(pushDir())).toEqual(["vapid.json"]);
    expect(readFileSync(file(), "utf8")).not.toContain("BEGIN");
    const point = Buffer.from(state.identity.publicKey, "base64url");
    expect(point.length).toBe(65);
    expect(point[0]).toBe(4);
    expect(state.identity.keyId).toBe(createHash("sha256").update(point).digest("hex").slice(0, 16));
  });

  it("stable-across-loads", () => {
    const first = ready(loadVapid(secrets, logger()));
    const second = ready(loadVapid(secrets, logger()));
    expect(second.identity.publicKey).toBe(first.identity.publicKey);
    expect(second.identity.keyId).toBe(first.identity.keyId);
    expect(second.minted).toBe(false);
  });

  it("refuses-group-readable", () => {
    loadVapid(secrets, logger());
    chmodSync(file(), 0o640);
    const before = readFileSync(file());
    expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    expect(readFileSync(file()).equals(before)).toBe(true);
  });

  it.each([
    ["truncated", () => '{"v":1,"privateJw'],
    [
      "wrong-curve",
      () =>
        JSON.stringify({
          v: 1,
          privateJwk: generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export({
            format: "jwk",
          }),
        }),
    ],
    ["v2", () => validJson().replace('"v":1', '"v":2')],
    ["d-bitflip", () => withD((d) => flip(d))],
    ["d-empty", () => withD(() => "")],
    [
      "d-mismatch",
      () => withD(() => ownD(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey)),
    ],
  ])("refuses-damaged (%s)", (_name, make) => {
    mkdirSync(pushDir(), { mode: 0o700 });
    const content = make();
    writeFileSync(file(), content, { mode: 0o600 });
    expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    expect(readFileSync(file(), "utf8")).toBe(content);
    expect(lines.filter((l) => l.includes("push_vapid_unreadable"))).toHaveLength(1);
    expect(reasons()).toEqual([expect.stringMatching(/^(parse|key_mismatch)$/)]);
    expect(lines.join("\n")).not.toContain("privateJw");
  });

  it("refuses-symlink-file", () => {
    mkdirSync(pushDir(), { mode: 0o700 });
    const target = join(secrets, "elsewhere.json");
    writeFileSync(target, validJson(), { mode: 0o600 });
    symlinkSync(target, file());
    expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    expect(readdirSync(secrets).sort()).toEqual(["elsewhere.json", "push"]);
  });

  it("refuses-symlink-dir", () => {
    const real = join(secrets, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, pushDir());
    expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses-open-dir", () => {
    mkdirSync(pushDir(), { mode: 0o755 });
    chmodSync(pushDir(), 0o755);
    expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    expect(readdirSync(pushDir())).toEqual([]);
  });

  it("stale-tmp-does-not-block", () => {
    mkdirSync(pushDir(), { mode: 0o700 });
    const stale = join(pushDir(), "vapid.json.0123456789abcdef.tmp");
    const pidNamed = join(pushDir(), `vapid.json.${process.pid}.tmp`);
    const fresh = join(pushDir(), "vapid.json.fedcba9876543210.tmp");
    writeFileSync(stale, "x", { mode: 0o600 });
    writeFileSync(fresh, "x", { mode: 0o600 });
    writeFileSync(pidNamed, "x", { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old); // only a leftover older than a minute goes; a fresh one may be a concurrent writer's
    expect(ready(loadVapid(secrets, logger())).minted).toBe(true);
    expect(readdirSync(pushDir()).sort()).toEqual(
      [`vapid.json`, `vapid.json.${process.pid}.tmp`, "vapid.json.fedcba9876543210.tmp"].sort(),
    );
  });

  it("d-mismatch-and-bitflip-name-key_mismatch", () => {
    mkdirSync(pushDir(), { mode: 0o700 });
    writeFileSync(
      file(),
      withD((d) => flip(d)),
      { mode: 0o600 },
    );
    loadVapid(secrets, logger());
    expect(reasons()).toEqual(["key_mismatch"]);
  });

  it("fifo-is-off-without-hanging", () => {
    mkdirSync(pushDir(), { mode: 0o700 });
    execFileSync("mkfifo", ["-m", "600", file()]);
    expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    expect(reasons()).toEqual(["not_file"]);
  });

  it("oversized-file-is-off", () => {
    mkdirSync(pushDir(), { mode: 0o700 });
    writeFileSync(file(), validJson() + " ".repeat(5000), { mode: 0o600 });
    expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    expect(reasons()).toEqual(["too_big"]);
  });

  it("strict-modes", () => {
    loadVapid(secrets, logger());
    chmodSync(file(), 0o400);
    expect(loadVapid(secrets, logger()).kind).toBe("off");
    chmodSync(file(), 0o600);
    chmodSync(pushDir(), 0o750);
    expect(loadVapid(secrets, logger()).kind).toBe("off");
    expect(reasons()).toEqual(["open_mode", "open_mode"]);
  });

  it("foreign-owner-file-is-off", () => {
    loadVapid(secrets, logger());
    const uid = process.getuid?.() ?? 0;
    // the folder check reads the uid first, the file check second
    const spy = vi
      .spyOn(process, "getuid")
      .mockReturnValueOnce(uid)
      .mockReturnValue(uid + 1);
    try {
      expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    } finally {
      spy.mockRestore();
    }
    expect(reasons()).toEqual(["owner"]);
  });

  it("foreign-owner-folder-is-off (and nothing is minted)", () => {
    loadVapid(secrets, logger());
    rmSync(file());
    const uid = process.getuid?.() ?? 0;
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    } finally {
      spy.mockRestore();
    }
    expect(reasons()).toEqual(["owner"]);
    expect(readdirSync(pushDir())).toEqual([]);
  });

  it("strict-folder-mode-is-exactly-0700", () => {
    loadVapid(secrets, logger());
    chmodSync(pushDir(), 0o500);
    try {
      expect(loadVapid(secrets, logger()).kind).toBe("off");
    } finally {
      chmodSync(pushDir(), 0o700);
    }
    expect(reasons()).toEqual(["open_mode"]);
  });

  it("create-failure-is-off-not-a-throw", () => {
    writeFileSync(pushDir(), "not a dir");
    expect(loadVapid(secrets, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    rmSync(pushDir());
    const readOnly = join(secrets, "ro");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      expect(loadVapid(readOnly, logger())).toEqual({ kind: "off", reason: "keys_unreadable" });
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });

  it("missing-mints", () => {
    const first = ready(loadVapid(secrets, logger()));
    rmSync(file());
    const second = ready(loadVapid(secrets, logger()));
    expect(second.minted).toBe(true);
    expect(second.identity.keyId).not.toBe(first.identity.keyId);
  });

  it("never-mints-over-existing", () => {
    loadVapid(secrets, logger());
    const before = readFileSync(file());
    chmodSync(file(), 0o644);
    loadVapid(secrets, logger());
    expect(readFileSync(file()).equals(before)).toBe(true);
    chmodSync(file(), 0o600);
    writeFileSync(file(), "garbage");
    loadVapid(secrets, logger());
    expect(readFileSync(file(), "utf8")).toBe("garbage");
  });

  it("logs-no-key", () => {
    const state = ready(loadVapid(secrets, logger()));
    chmodSync(file(), 0o640);
    loadVapid(secrets, logger());
    const all = lines.join("\n");
    expect(lines).toHaveLength(1);
    expect(all).not.toContain("privateJwk");
    expect(all).not.toContain('d":');
    expect(all).not.toContain(state.identity.publicKey);
  });

  it("jwt-verifies", () => {
    const state = ready(loadVapid(secrets, logger()));
    const now = 1_700_000_000_000;
    const header = state.identity.sign("https://push.example", "mailto:owner@pap.example", now);
    const [t, k] = header.split(", ");
    expect(k).toBe(`k=${state.identity.publicKey}`);
    const [head = "", body = "", sig = ""] = (t ?? "").slice(2).split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(Buffer.from(body, "base64url").toString())).toEqual({
      aud: "https://push.example",
      exp: now / 1000 + 12 * 3600,
      sub: "mailto:owner@pap.example",
    });
    const point = Buffer.from(state.identity.publicKey, "base64url");
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${body}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(sig, "base64url"),
      ),
    ).toBe(true);
  });
});
