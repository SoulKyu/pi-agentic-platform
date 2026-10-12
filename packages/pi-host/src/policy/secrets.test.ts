import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSecrets, createSecretSource, credentialWords, isWeakEnvValue } from "./secrets.ts";

const names = (env: NodeJS.ProcessEnv, authJson: string | null = null) =>
  collectSecrets({ env, authJson }).entries.map((entry) => entry.name);

let stderr: { mock: { calls: unknown[][] }; mockRestore(): void } | undefined;
const lines = () => (stderr?.mock.calls ?? []).map((call) => String(call[0]));
function captureStderr() {
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}
afterEach(() => {
  stderr?.mockRestore();
  stderr = undefined;
});

describe("credentialWords", () => {
  it("splits on separators and case changes", () => {
    expect(credentialWords("myApiKey")).toEqual(["my", "api", "key"]);
    expect(credentialWords("GITHUB_TOKEN")).toEqual(["github", "token"]);
    expect(credentialWords("PASSWORD_FILE.x")).toEqual(["password", "file", "x"]);
    expect(credentialWords("APIKey")).toEqual(["api", "key"]);
    expect(credentialWords("a-b")).toEqual(["a", "b"]);
  });
});

describe("collectSecrets from the environment", () => {
  it("keeps credential-named variables of 8 to 4096 characters that are not paths, digits or booleans", () => {
    expect(
      names({
        GITHUB_TOKEN: "ghp_123456789",
        AWS_SECRET_ACCESS_KEY: "abc/def+ghi=jk",
        HOME_DIR_PATH: "/home/x/very/long",
        SHORT_TOKEN: "1234567",
        PORT_TOKEN: "12345678",
        PATH: "/usr/bin:/bin",
        MY_PASSPHRASE: "correct horse",
        FLAG_SECRET: "TRUE",
        ROOT_TOKEN: "/opt/some/long/path",
        HUGE_TOKEN: "x1".repeat(2049),
        EMPTY_TOKEN: undefined,
      }),
    ).toEqual(["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "MY_PASSPHRASE"]);
  });

  it("recognises the credential words, alone or in pairs, and not look-alike words", () => {
    const value = (tag: string) => `Xx-0123456789-${tag}`;
    const hits = names({
      A_PASSWD: value("A_PASSWD"),
      B_PASS: value("B_PASS"),
      C_APIKEY: value("C_APIKEY"),
      D_API_KEY: value("D_API_KEY"),
      E_ACCESS_KEY: value("E_ACCESS_KEY"),
      F_PRIVATE_KEY: value("F_PRIVATE_KEY"),
      G_SECRET_KEY: value("G_SECRET_KEY"),
      H_AUTH: value("H_AUTH"),
      I_CREDENTIALS: value("I_CREDENTIALS"),
      J_COOKIE: value("J_COOKIE"),
      K_BEARER: value("K_BEARER"),
      L_JWT: value("L_JWT"),
      mixedApiKey: value("mixedApiKey"),
    });
    expect(hits).toEqual([
      "A_PASSWD",
      "B_PASS",
      "C_APIKEY",
      "D_API_KEY",
      "E_ACCESS_KEY",
      "F_PRIVATE_KEY",
      "G_SECRET_KEY",
      "H_AUTH",
      "I_CREDENTIALS",
      "J_COOKIE",
      "K_BEARER",
      "L_JWT",
      "mixedApiKey",
    ]);
    expect(
      names({
        AUTHOR_NAME: value("a"),
        COMPASS_DIR: value("b"),
        KEY_ONLY: value("c"),
        PUBLIC_KEY: value("d"),
      }),
    ).toEqual([]);
  });

  it("does not treat placeholders and weak values as secrets (MQ5)", () => {
    expect(
      names({
        POSTGRES_PASSWORD: "postgres",
        MYSQL_ROOT_PASSWORD: "password",
        REDIS_PASSWORD: "changeme",
        API_TOKEN: "Passw0rd",
        X_TOKEN: "abcdefghijk",
        ADMIN_PASSWORD: "ADMIN123",
        APP_SECRET: "Example123",
        HOST_TOKEN: "localhost",
      }),
    ).toEqual([]);
    expect(names({ PG_PASSWORD: "correcthorsebattery", DB_TOKEN: "s3cr3t-Value-1" })).toEqual([
      "PG_PASSWORD",
      "DB_TOKEN",
    ]);
  });

  it("one repeated character is weak, in any length and case", () => {
    expect(isWeakEnvValue("xxxxxxxxxxxx")).toBe(true);
    expect(isWeakEnvValue("A".repeat(300))).toBe(true);
    expect(isWeakEnvValue("1111111111")).toBe(true);
    expect(isWeakEnvValue("xxxxxxxxxxxy")).toBe(false);
    expect(names({ A_TOKEN: "ZZZZZZZZZZZZZZ" })).toEqual([]);
  });

  it("isWeakEnvValue: lower-case letters under 12, or a listed placeholder in any case", () => {
    expect(isWeakEnvValue("abcdefgh")).toBe(true);
    expect(isWeakEnvValue("abcdefghijkl")).toBe(false);
    expect(isWeakEnvValue("Postgres")).toBe(true);
    expect(isWeakEnvValue("aB3-xyz9")).toBe(false);
  });

  it("sanitises names that are not [A-Za-z0-9_], caps them at 64, keeps the first of equal values", () => {
    const set = collectSecrets({
      env: {
        "my-token.v2": "value-0123456789",
        ["T".repeat(80) + "_TOKEN"]: "long-name-0123456789",
        OTHER_TOKEN: "value-0123456789",
      },
      authJson: null,
    });
    expect(set.entries.map((entry) => entry.name)).toEqual([
      "my_token_v2",
      ("T".repeat(80) + "_TOKEN").slice(0, 64),
    ]);
  });

  it("keeps the 256 longest of 300 candidates", () => {
    const env: NodeJS.ProcessEnv = {};
    for (let i = 0; i < 300; i++) {
      const id = String(i).padStart(3, "0");
      env[`K${id}_TOKEN`] = i < 44 ? `Aa-${id}-zz` : `Aa-${id}-zz-longer-value`;
    }
    const set = collectSecrets({ env, authJson: null });
    expect(set.entries).toHaveLength(256);
    expect(set.entries.every((entry) => entry.value.endsWith("longer-value"))).toBe(true);
    expect(set.entries[0]?.name).toBe("K044_TOKEN");
  });
});

describe("credential names (the daemon logger's words, widened)", () => {
  const value = (tag: string) => `Xk-9f3a7c1e5b-${tag}`;
  const table: Array<[string, boolean]> = [
    ["GITHUB_TOKEN2", true],
    ["GITHUB_TOKEN_2", true],
    ["MY_SECRETS", true],
    ["DB_PASSWORDS", true],
    ["CLIENTSECRET", true],
    ["ACCESSTOKEN", true],
    ["NGROK_AUTHTOKEN", true],
    ["HTTP_AUTHORIZATION", true],
    ["WEBHOOK_HMAC", true],
    ["HMAC_KEY", true],
    ["JWT_SIGNING_KEY", true],
    ["SIGNINGKEY", true],
    ["DATA_ENCRYPTION_KEY", true],
    ["PGPASSWORD", true],
    ["MYSQL_PWD", true],
    ["SSHPASS", true],
    ["GITHUB_TOKENS", true],
    ["authToken", true],
    ["AUTHOR_NAME", false],
    ["COMPASS_DIR", false],
    ["PUBLIC_KEY", false],
    ["TOKENIZER_MODE", false],
    ["PASSENGER_COUNT", false],
    ["MAX_TOKENS_X", false],
  ];
  it.each(table)("%s -> %s", (name, secret) => {
    expect(names({ [name]: value(name) })).toEqual(secret ? [name] : []);
  });
  it("the strength floor still applies to a widened name", () => {
    expect(names({ PGPASSWORD: "postgres", SSHPASS: "xxxxxxxxxxxx", MYSQL_PWD: "abcdefghij" })).toEqual([]);
  });
});

describe("collectSecrets from auth.json", () => {
  const auth = JSON.stringify({
    anthropic: { type: "api_key", key: "sk-ant-0123456789" },
    openai: { type: "oauth", access: "at-0123456789", refresh: "rt-0123456789", expires: 123 },
    cmd: { key: "!pass show x" },
    short: { key: "1234567" },
    "my.provider": { apiKey: "pk-0123456789", token: "password" },
  });

  it("names the credentials AUTH_<PROVIDER>_<FIELD>, skips !commands, short values and non-credential fields", () => {
    const set = collectSecrets({ env: {}, authJson: auth });
    expect(set.entries.map((entry) => entry.name)).toEqual([
      "AUTH_ANTHROPIC_KEY",
      "AUTH_OPENAI_ACCESS",
      "AUTH_OPENAI_REFRESH",
      "AUTH_MY_PROVIDER_API_KEY",
      "AUTH_MY_PROVIDER_TOKEN",
    ]);
  });

  it("has no strength floor: an 8-character 'password' from auth.json is kept", () => {
    expect(collectSecrets({ env: {}, authJson: auth }).entries).toContainEqual({
      name: "AUTH_MY_PROVIDER_TOKEN",
      value: "password",
    });
  });

  it("a Pi reference ($VAR, ${VAR}) is no secret; escaped $$ and $! literals are", () => {
    const set = collectSecrets({
      env: {},
      authJson: JSON.stringify({
        a: { key: "$OPENAI_API_KEY" },
        b: { key: "prefix-${SECRET_VAR}" },
        c: { key: "pa$$word-0123456789" },
        d: { key: "$!bang-0123456789" },
        e: { key: "$$$VAR-0123456789" },
        f: { key: "cost-in-$-0123456789" },
      }),
    });
    expect(set.entries.map((entry) => entry.name)).toEqual(["AUTH_C_KEY", "AUTH_D_KEY", "AUTH_F_KEY"]);
  });

  it("an environment name wins a duplicate value over the auth.json name", () => {
    const set = collectSecrets({ env: { ANTHROPIC_API_KEY: "sk-ant-0123456789" }, authJson: auth });
    expect(set.entries.filter((entry) => entry.value === "sk-ant-0123456789")).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-0123456789" },
    ]);
  });

  it("a corrupt, mis-shaped or 2 MiB auth.json gives nothing and one stderr line", () => {
    captureStderr();
    for (const bad of ["{not json", "[1,2]", JSON.stringify({ a: { key: "x".repeat(2 * 1024 * 1024) } })]) {
      expect(collectSecrets({ env: {}, authJson: bad }).entries).toEqual([]);
    }
    expect(lines()).toHaveLength(3);
    expect(
      lines().every((line) => /^pi-host: auth\.json not read for redaction \([a-z-]+\)\n$/.test(line)),
    ).toBe(true);
    expect(lines().join("")).not.toContain("xxxx");
  });

  it("a null auth.json is silent", () => {
    captureStderr();
    expect(collectSecrets({ env: {}, authJson: null }).entries).toEqual([]);
    expect(lines()).toEqual([]);
  });
});

describe("createSecretSource", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function agentDir(authJson?: object): string {
    const dir = mkdtempSync(join(tmpdir(), "pap-secrets-"));
    dirs.push(dir);
    if (authJson) writeFileSync(join(dir, "auth.json"), JSON.stringify(authJson));
    return dir;
  }
  const bump = (dir: string, seconds: number) => {
    const when = new Date(Date.now() + seconds * 1000);
    utimesSync(join(dir, "auth.json"), when, when);
  };

  it("rebuilds the redactor when auth.json changed and only then (M5R121)", () => {
    const dir = agentDir({ openai: { access: "at-0123456789" } });
    const source = createSecretSource({ env: {}, agentDir: dir });
    const first = source.current();
    expect(first.text("x at-0123456789").text).toBe("x [SECRET:AUTH_OPENAI_ACCESS]");
    source.refresh();
    expect(source.current()).toBe(first);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: { access: "at-9876543210" } }));
    bump(dir, 2);
    source.refresh();
    expect(source.current()).not.toBe(first);
    expect(source.current().text("at-9876543210").text).toBe("[SECRET:AUTH_OPENAI_ACCESS]");
  });

  it("a missing auth.json is fine; one that appears later is read", () => {
    const dir = agentDir();
    captureStderr();
    const source = createSecretSource({ env: { MY_TOKEN: "env-0123456789" }, agentDir: dir });
    source.refresh();
    expect(lines()).toEqual([]);
    expect(source.current().text("env-0123456789").count).toBe(1);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: { access: "at-0123456789" } }));
    source.refresh();
    expect(source.current().text("at-0123456789").count).toBe(1);
    expect(source.current().text("env-0123456789").count).toBe(1);
  });

  it("a later corrupt file keeps the current set and writes one line per change of code", () => {
    const dir = agentDir({ openai: { access: "at-0123456789" } });
    captureStderr();
    const source = createSecretSource({ env: {}, agentDir: dir });
    const first = source.current();
    writeFileSync(join(dir, "auth.json"), "{broken");
    bump(dir, 2);
    source.refresh();
    writeFileSync(join(dir, "auth.json"), "{broken again");
    bump(dir, 4);
    source.refresh();
    expect(source.current()).toBe(first);
    expect(lines()).toEqual(["pi-host: auth.json not read for redaction (invalid-json)\n"]);
  });

  it("an auth.json above 1 MiB contributes nothing and is not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-secrets-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), " ".repeat(1024 * 1024 + 1));
    captureStderr();
    const source = createSecretSource({ env: {}, agentDir: dir });
    expect(source.current().size).toBe(0);
    expect(lines()).toEqual(["pi-host: auth.json not read for redaction (too-large)\n"]);
  });

  it("rebuilds when the file was replaced with the same size and mtime (ctime is in the signature)", () => {
    const dir = agentDir({ openai: { access: "at-0123456789" } });
    const path = join(dir, "auth.json");
    const fixed = 1_700_000_000;
    utimesSync(path, fixed, fixed);
    const source = createSecretSource({ env: {}, agentDir: dir });
    const first = source.current();
    writeFileSync(path, JSON.stringify({ openai: { access: "at-9876543210" } }));
    utimesSync(path, fixed, fixed);
    source.refresh();
    expect(source.current()).not.toBe(first);
    expect(source.current().text("at-9876543210").count).toBe(1);
  });

  it("a FIFO or a link to /dev/zero is not read, does not hang, and is reported once", () => {
    const dir = agentDir();
    const path = join(dir, "auth.json");
    execFileSync("mkfifo", [path]);
    captureStderr();
    const source = createSecretSource({ env: {}, agentDir: dir });
    source.refresh();
    expect(source.current().size).toBe(0);
    rmSync(path);
    symlinkSync("/dev/zero", path);
    source.refresh();
    expect(source.current().size).toBe(0);
    expect(lines()).toEqual(["pi-host: auth.json not read for redaction (not-a-file)\n"]);
  });

  it("a file that grew past 1 MiB after the stat is cut at the bound and refused", () => {
    const dir = agentDir();
    writeFileSync(join(dir, "auth.json"), "{}");
    captureStderr();
    const source = createSecretSource({ env: {}, agentDir: dir });
    writeFileSync(join(dir, "auth.json"), " ".repeat(1024 * 1024 + 5));
    source.refresh();
    expect(lines()).toEqual(["pi-host: auth.json not read for redaction (too-large)\n"]);
  });
});
