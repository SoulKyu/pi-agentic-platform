import { describe, expect, it } from "vitest";
import {
  InitRecord,
  OnceValues,
  VAULT_CAPS,
  VaultName,
  VaultUpdateRecord,
  VaultValue,
  VaultValues,
} from "./index.ts";
import { isVaultName } from "./vault-names.ts";

const HIJACK = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "TERM",
  "GLIBC_TUNABLES",
  "GCONV_PATH",
  "SSL_CERT_FILE",
  "LOCPATH",
  "NLSPATH",
  "HOSTALIASES",
  "RESOLV_HOST_CONF",
  "RES_OPTIONS",
  "LOCALDOMAIN",
  "MALLOC_TRACE",
  "TZDIR",
  "GETCONF_DIR",
  "NIS_PATH",
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "GIT_DIR",
  "NODE_OPTIONS",
  "PI_SESSION",
  "PAP_HOME",
  "BASH_FUNC_x",
  "LC_ALL",
  "NPM_CONFIG_REGISTRY",
  "HTTPS_PROXY",
  "MY_PROXY",
];

describe("isVaultName (W5-R17)", () => {
  it.each(HIJACK)("refuses %s", (name) => {
    expect(isVaultName(name)).toBe(false);
    expect(VaultName.safeParse(name).success).toBe(false);
  });
  it.each(["GITHUB_TOKEN", "VAULT_TOKEN", "A", "DB_PASSWORD", "LDAP_PASSWORD"])("accepts %s", (name) => {
    expect(isVaultName(name)).toBe(true);
    expect(VaultName.safeParse(name).success).toBe(true);
  });
  it.each(["lower", "1ABC", "", "A".repeat(65), "A-B"])("refuses the malformed %j", (name) => {
    expect(isVaultName(name)).toBe(false);
  });
  it("refuses a hijack name in every record that carries a vault", () => {
    expect(VaultValues.safeParse({ LD_PRELOAD: "/x/evil.so" }).success).toBe(false);
    expect(VaultValues.safeParse({ GITHUB_TOKEN: "ghp_0123456789" }).success).toBe(true);
    expect(OnceValues.safeParse([{ name: "LD_AUDIT", value: "x" }]).success).toBe(false);
    expect(
      VaultUpdateRecord.safeParse({ type: "vault_update", vault: { LD_PRELOAD: "x" }, once: [] }).success,
    ).toBe(false);
    const init = { type: "init", cwd: "/w", agentDir: "/a", papHome: "/p", umask: 18, policy: {} };
    expect(InitRecord.safeParse({ ...init, vault: { GLIBC_TUNABLES: "x" } }).success).toBe(false);
  });
});

describe("the vault caps", () => {
  it("are the ones the value and the whole vault enforce", () => {
    expect(VaultValue.safeParse("x".repeat(VAULT_CAPS.valueChars)).success).toBe(true);
    expect(VaultValue.safeParse("x".repeat(VAULT_CAPS.valueChars + 1)).success).toBe(false);
    const names = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, n) => [`NAME_${n}`, "v"]));
    expect(VaultValues.safeParse(names(VAULT_CAPS.names)).success).toBe(true);
    expect(VaultValues.safeParse(names(VAULT_CAPS.names + 1)).success).toBe(false);
  });
});
