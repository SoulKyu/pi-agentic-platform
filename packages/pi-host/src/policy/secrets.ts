import { VAULT_CAPS } from "@pap/contracts/pi-host";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRedactor, type Redactor, type SecretSet } from "./redact.ts";

const MIN_LENGTH = 8;
const MAX_ENV_LENGTH = 4096;
const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_SECRETS = 256;
const MAX_NAME = 64;

const NAME_PREFIX = "(?:access|refresh|id|auth|session|bearer|api|csrf|xsrf|oauth|client|app|shared|webhook)";
/**
 * The words that make an environment variable a credential, over the lower-case words of its name joined by `_`: the
 * daemon logger's list (a digit may follow a word, a word may be plural or glued to a prefix: `CLIENTSECRET`,
 * `NGROK_AUTHTOKEN`, `DB_PASSWORDS`, `GITHUB_TOKEN2`) plus bare `auth` and the client variables `PGPASSWORD`,
 * `MYSQL_PWD`, `SSHPASS`.
 */
const CREDENTIAL_NAME = new RegExp(
  `(?:^|_)(?:${NAME_PREFIX}?_?(?:token|secrets?)|pass|passwd|passwords?|passphrase|pgpassword|sshpass|pwd|cookies?|authorization|auth|credentials?|(?:api|private|signing|encryption|secret|access|hmac)_?keys?|hmac|bearer|jwt)\\d*(?:_|$)`,
);
/** Values pap treats as placeholders, compared case-folded (owner MQ5). */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "password",
  "postgres",
  "changeme",
  "secret",
  "admin",
  "example",
  "default",
  "localhost",
  "password1",
  "passw0rd",
  "p@ssw0rd",
  "admin123",
  "secret123",
  "changeme123",
  "example123",
  "postgres123",
]);
const AUTH_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "apiKey",
  "api_key",
  "access",
  "accessToken",
  "access_token",
  "refresh",
  "refreshToken",
  "refresh_token",
  "token",
  "secret",
  "password",
]);

/** The words of a name, lower case: pi-host cannot import the daemon, so this is its own copy, pinned by its own test. */
export function credentialWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

// A list of tokens is a secret list; `max_tokens` in the middle of a name is a count.
const TOKEN_LIST = /tokens\d*$/;
const isCredentialName = (name: string): boolean => {
  const words = credentialWords(name).join("_");
  return CREDENTIAL_NAME.test(words) || TOKEN_LIST.test(words);
};

/** A value of lower-case letters only and under 12, one character repeated, or a common placeholder: a guess, not a credential (owner MQ5). */
export function isWeakEnvValue(value: string): boolean {
  return (
    (/^[a-z]+$/.test(value) && value.length < 12) ||
    PLACEHOLDERS.has(value.toLowerCase()) ||
    /^(.)\1*$/su.test(value)
  );
}

const isEnvSecret = (value: string): boolean =>
  value.length >= MIN_LENGTH &&
  value.length <= MAX_ENV_LENGTH &&
  !value.startsWith("/") &&
  !/^[0-9]+$/.test(value) &&
  !["true", "false"].includes(value.toLowerCase()) &&
  !isWeakEnvValue(value);

/** Pi resolves `$VAR` and `${VAR}` from the environment; `$$` and `$!` are escaped literals: a reference is no secret. */
const isPiReference = (value: string): boolean => /\$[{A-Za-z_]/.test(value.replace(/\$[$!]/g, ""));

/** `pinned`: a vault value, which the cap on the environment's secrets never drops (M11R26). */
type Candidate = { name: string; value: string; restorable?: false; pinned?: true };

/** Parses Pi's `auth.json`; `problem` is a stable code, never a message (it can quote the file). */
function authCandidates(authJson: string): { found: Candidate[]; problem?: string } {
  if (authJson.length > MAX_AUTH_BYTES) return { found: [], problem: "too-large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return { found: [], problem: "invalid-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { found: [], problem: "invalid-shape" };
  }
  const found: Candidate[] = [];
  for (const [provider, record] of Object.entries(parsed)) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    const providerName = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    for (const [field, value] of Object.entries(record)) {
      if (!AUTH_FIELDS.has(field) || typeof value !== "string") continue;
      // Pi resolves `key` alone (a command, `$VAR` references, escapes); every other field is a literal.
      let literal = value;
      if (field === "key") {
        if (value.startsWith("!") || isPiReference(value)) continue;
        literal = value.replace(/\$([$!])/g, "$1");
      }
      if (literal.length < MIN_LENGTH) continue;
      const fieldName = credentialWords(field).join("_").toUpperCase();
      found.push({
        name: `AUTH_${providerName}_${fieldName}`.slice(0, MAX_NAME),
        value: literal,
        restorable: false,
      });
    }
  }
  return { found };
}

function build(
  env: NodeJS.ProcessEnv,
  authJson: string | null,
  vault: readonly Candidate[] = [],
): { set: SecretSet; problem?: string } {
  // The vault goes first: its values keep their names, and an environment secret of the same name gets the counter.
  const candidates: Candidate[] = [...vault];
  for (const [rawName, value] of Object.entries(env)) {
    if (value === undefined || !isCredentialName(rawName) || !isEnvSecret(value)) continue;
    const name = rawName.replace(/[^A-Za-z0-9_]/g, "_").slice(0, MAX_NAME);
    if (name !== "") candidates.push({ name, value });
  }
  const auth = authJson === null ? { found: [] } : authCandidates(authJson);
  candidates.push(...auth.found);
  // The first name of a value stays; a name another value already has gets a counter, so markers stay unambiguous.
  const values = new Set<string>();
  const names = new Set<string>();
  let unique: Candidate[] = [];
  for (const { name, value, restorable, pinned } of candidates) {
    if (values.has(value)) continue;
    values.add(value);
    let final = name;
    for (let n = 2; names.has(final); n++) final = `${name.slice(0, MAX_NAME - 3)}_${n}`;
    names.add(final);
    unique.push({
      name: final,
      value,
      ...(restorable === false ? { restorable } : {}),
      ...(pinned === true ? { pinned } : {}),
    });
  }
  if (unique.length > MAX_SECRETS) {
    const keep = new Set(unique.flatMap((entry, index) => (entry.pinned === true ? [index] : [])));
    const room = Math.max(0, MAX_SECRETS - keep.size);
    unique
      .map((entry, index) => ({ index, length: entry.value.length, pinned: entry.pinned === true }))
      .filter((item) => !item.pinned)
      .sort((a, b) => b.length - a.length || a.index - b.index)
      .slice(0, room)
      .forEach((item) => keep.add(item.index));
    unique = unique.filter((_, index) => keep.has(index));
  }
  const entries = unique.map(({ name, value, restorable }) => ({
    name,
    value,
    ...(restorable === false ? { restorable } : {}),
  }));
  return { set: { entries }, ...(auth.problem === undefined ? {} : { problem: auth.problem }) };
}

const reportProblem = (code: string): void => {
  process.stderr.write(`pi-host: auth.json not read for redaction (${code})\n`);
};

/** The secrets a worker knows: its credential-named environment and Pi's `auth.json` (M5R35). */
export function collectSecrets({
  env,
  authJson,
}: {
  env: NodeJS.ProcessEnv;
  authJson: string | null;
}): SecretSet {
  const built = build(env, authJson);
  if (built.problem !== undefined) reportProblem(built.problem);
  return built.set;
}

export interface SecretSource {
  current(): Redactor;
  /** One `stat` of `auth.json`; the redactor is rebuilt only when the file changed. */
  refresh(): void;
  /**
   * Replaces the agent's vault (`init.vault`, `vault_update`; M11R26): every value of 8 characters or more is redacted as
   * `[SECRET:<NAME>]` and never restored into a write. A value that leaves the vault stays redacted (the 128 newest to leave,
   * until the worker exits): it may already sit in the model's context or in a file, and forgetting it would only help a leak.
   */
  setVault(entries: Readonly<Record<string, string>>): void;
  /**
   * Replaces the waiting one-use values (Task 18): one redactor entry per VALUE, never a map keyed by name, so two values of
   * one name are both redacted. Like the vault, a value that leaves stays redacted (within the same 128 retired values).
   */
  setOnce(entries: ReadonlyArray<{ readonly name: string; readonly value: string }>): void;
}

/** What the policy needs of the secrets: it reads them, and only the host changes the vault. */
export type SecretReader = Pick<SecretSource, "current" | "refresh">;

/** The most one-use values a worker holds (the contract's `OnceValues` maximum; a test pins them equal). */
export const ONCE_MAX = 3;
/** Slots of the 256 that environment and `auth.json` credentials always keep, whatever the vault holds. */
const CREDENTIAL_FLOOR = 75;
/**
 * The most values a worker keeps redacting after they left the vault or the one-use list (the oldest are forgotten first).
 * They are pinned like the live ones, so the pinned total is at most vault names + one-use + this, and the rest of the
 * 256 slots (at least `CREDENTIAL_FLOOR`) is left to the credentials. Derived from the contract's caps: raising
 * `VAULT_CAPS.names` lowers this number instead of shrinking the floor.
 */
const MAX_RETIRED = MAX_SECRETS - VAULT_CAPS.names - ONCE_MAX - CREDENTIAL_FLOOR;

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : "unknown";
};

/**
 * At most `maxBytes + 1` bytes of a regular file. Opened without blocking and checked after the open, so a FIFO put in
 * place after the `stat` cannot hang the worker; one byte more than allowed says "too large" without reading on.
 */
export function readBounded(
  path: string,
  maxBytes = MAX_AUTH_BYTES,
): { text: string } | { problem: "not-a-file" | "too-large" } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return { problem: "not-a-file" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return length > maxBytes ? { problem: "too-large" } : { text: buffer.toString("utf8", 0, length) };
  } finally {
    closeSync(fd);
  }
}

/** Built at session open and refreshed once per tool result: an OAuth refresh rewrites the tokens (M5R121). */
export function createSecretSource({
  env,
  agentDir,
}: {
  env: NodeJS.ProcessEnv;
  agentDir: string;
}): SecretSource {
  const path = join(agentDir, "auth.json");
  let redactor = createRedactor(build(env, null).set);
  let authText: string | null = null;
  let vault: Readonly<Record<string, string>> = {};
  const retired = new Map<string, string>();
  let onceList: ReadonlyArray<{ readonly name: string; readonly value: string }> = [];
  const vaultCandidates = (): Candidate[] =>
    [
      ...Object.entries(vault),
      ...onceList.map(({ name, value }) => [name, value] as const),
      ...[...retired].map(([value, name]) => [name, value] as const),
    ]
      .filter(([, value]) => value.length >= MIN_LENGTH)
      .map(([name, value]) => ({ name, value, restorable: false as const, pinned: true as const }));
  const rebuild = (): void => {
    redactor = createRedactor(build(env, authText, vaultCandidates()).set);
  };
  let signature: string | undefined;
  let lastCode: string | undefined;
  const fail = (code: string) => {
    if (code !== lastCode) reportProblem(code);
    lastCode = code;
  };
  const refresh = (): void => {
    let next: string | undefined;
    try {
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat === undefined) {
        signature = undefined;
        lastCode = undefined;
        return;
      }
      next = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (next === signature) return;
      if (!stat.isFile()) {
        signature = next;
        fail("not-a-file");
        return;
      }
      const read = stat.size > MAX_AUTH_BYTES ? { problem: "too-large" as const } : readBounded(path);
      signature = next;
      if ("problem" in read) {
        fail(read.problem);
        return;
      }
      const built = build(env, read.text, vaultCandidates());
      if (built.problem !== undefined) {
        fail(built.problem);
        return;
      }
      lastCode = undefined;
      authText = read.text;
      redactor = createRedactor(built.set);
    } catch (error) {
      fail(codeOf(error));
    }
  };
  refresh();
  const setVault = (entries: Readonly<Record<string, string>>): void => {
    for (const [name, value] of Object.entries(vault)) {
      retired.delete(value);
      retired.set(value, name);
    }
    vault = { ...entries };
    for (const value of Object.values(vault)) retired.delete(value);
    for (const oldest of [...retired.keys()].slice(0, Math.max(0, retired.size - MAX_RETIRED)))
      retired.delete(oldest);
    rebuild();
  };
  const setOnce: SecretSource["setOnce"] = (entries) => {
    for (const { name, value } of onceList) {
      retired.delete(value);
      retired.set(value, name);
    }
    onceList = entries.map(({ name, value }) => ({ name, value }));
    for (const { value } of onceList) retired.delete(value);
    for (const value of Object.values(vault)) retired.delete(value);
    for (const oldest of [...retired.keys()].slice(0, Math.max(0, retired.size - MAX_RETIRED)))
      retired.delete(oldest);
    rebuild();
  };
  return { current: () => redactor, refresh, setVault, setOnce };
}
