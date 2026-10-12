import { closeSync, openSync, readSync, statSync } from "node:fs";
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

type Candidate = { name: string; value: string };

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
      if (value.length < MIN_LENGTH || value.startsWith("!") || isPiReference(value)) continue;
      const fieldName = credentialWords(field).join("_").toUpperCase();
      found.push({ name: `AUTH_${providerName}_${fieldName}`.slice(0, MAX_NAME), value });
    }
  }
  return { found };
}

function build(env: NodeJS.ProcessEnv, authJson: string | null): { set: SecretSet; problem?: string } {
  const candidates: Candidate[] = [];
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
  for (const { name, value } of candidates) {
    if (values.has(value)) continue;
    values.add(value);
    let final = name;
    for (let n = 2; names.has(final); n++) final = `${name.slice(0, MAX_NAME - 3)}_${n}`;
    names.add(final);
    unique.push({ name: final, value });
  }
  if (unique.length > MAX_SECRETS) {
    const keep = new Set(
      unique
        .map((entry, index) => ({ index, length: entry.value.length }))
        .sort((a, b) => b.length - a.length || a.index - b.index)
        .slice(0, MAX_SECRETS)
        .map((item) => item.index),
    );
    unique = unique.filter((_, index) => keep.has(index));
  }
  return { set: { entries: unique }, ...(auth.problem === undefined ? {} : { problem: auth.problem }) };
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
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : "unknown";
};

/** At most `MAX_AUTH_BYTES + 1` bytes of a regular file: one more than allowed says "too large" without reading on. */
function readBounded(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_AUTH_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return length > MAX_AUTH_BYTES ? null : buffer.toString("utf8", 0, length);
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
      const text = stat.size > MAX_AUTH_BYTES ? null : readBounded(path);
      signature = next;
      if (text === null) {
        fail("too-large");
        return;
      }
      const built = build(env, text);
      if (built.problem !== undefined) {
        fail(built.problem);
        return;
      }
      lastCode = undefined;
      redactor = createRedactor(built.set);
    } catch (error) {
      fail(codeOf(error));
    }
  };
  refresh();
  return { current: () => redactor, refresh };
}
