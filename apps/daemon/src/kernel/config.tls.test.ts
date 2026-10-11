import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selfSignedCertificate } from "../testing/self-signed.ts";
import { ConfigError, loadConfig, type ConfigInput } from "./config.ts";

let dir: string;
let base: ConfigInput;
let cert: string;
let key: string;
let otherKey: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-tls-"));
  const first = selfSignedCertificate(dir);
  cert = first.cert;
  key = first.key;
  // A second pair gives a key that does not belong to the first certificate.
  mkdirSync(join(dir, "other"));
  otherKey = selfSignedCertificate(join(dir, "other")).key;
  base = {
    argv: [],
    env: {},
    cwd: dir,
    homedir: "/home/u",
    totalMemMb: 16_384,
    piHostEntry: "/x/main.js",
    piHostExecArgv: [],
    staticRoot: null,
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const withTls = (certPath: string, keyPath: string): ConfigInput => ({
  ...base,
  argv: ["--tls-cert", certPath, "--tls-key", keyPath],
});
const message = (input: ConfigInput): string => {
  try {
    loadConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  return "";
};

describe("--tls-cert and --tls-key", () => {
  it("are read once, at configuration, and the https origin follows", () => {
    const config = loadConfig(withTls(cert, key));
    expect(config.tls?.cert.equals(readFileSync(cert))).toBe(true);
    expect(config.tls?.key.equals(readFileSync(key))).toBe(true);
    expect(config.publicOrigin).toBe("https://localhost:7777");
  });

  it("name the flag, and only the errno, when a file is missing", () => {
    const missing = join(dir, "secret-name", "gone.pem");
    expect(message(withTls(missing, key))).toBe("--tls-cert cannot be read (ENOENT)");
    expect(message(withTls(cert, missing))).toBe("--tls-key cannot be read (ENOENT)");
    expect(message(withTls(missing, key))).not.toContain("secret-name");
  });

  it("name the flag when a file is not what it should be", () => {
    const junk = join(dir, "junk.pem");
    writeFileSync(junk, "not a pem file\n");
    expect(message(withTls(junk, key))).toBe("--tls-cert is not a certificate in PEM format");
    expect(message(withTls(cert, junk))).toBe("--tls-key is not an unencrypted private key in PEM format");
    // The certificate where the key belongs, and the other way round.
    expect(message(withTls(cert, cert))).toBe("--tls-key is not an unencrypted private key in PEM format");
    expect(message(withTls(key, key))).toBe("--tls-cert is not a certificate in PEM format");
  });

  it("refuse a key that belongs to another certificate", () => {
    expect(message(withTls(cert, otherKey))).toBe("--tls-key does not match --tls-cert");
  });

  it("still go together", () => {
    expect(message({ ...base, argv: ["--tls-cert", cert] })).toBe("--tls-cert and --tls-key go together");
  });
});
