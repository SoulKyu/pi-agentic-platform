import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRedactor, type Redactor, type SecretSet } from "./redact.ts";

const MIN_LENGTH = 8;
const MAX_ENV_LENGTH = 4096;
const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_SECRETS = 256;
const MAX_NAME = 64;

const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "pass",
  "passphrase",
  "apikey",
  "auth",
  "credential",
  "credentials",
  "cookie",
  "bearer",
  "jwt",
]);
const CREDENTIAL_PAIRS: ReadonlySet<string> = new Set(["api key", "access key", "private key", "secret key"]);
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

/** A copy of the daemon's helper: pi-host cannot import the daemon, and its own test pins this one. */
export function credentialWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

const isCredentialName = (name: string): boolean => {
  const words = credentialWords(name);
  return words.some(
    (word, i) => CREDENTIAL_WORDS.has(word) || CREDENTIAL_PAIRS.has(`${word} ${words[i + 1]}`),
  );
};

/** A value of lower-case letters only and under 12, or a common placeholder: a guess, not a credential (owner MQ5). */
export function isWeakEnvValue(value: string): boolean {
  return (/^[a-z]+$/.test(value) && value.length < 12) || PLACEHOLDERS.has(value.toLowerCase());
}

const isEnvSecret = (value: string): boolean =>
  value.length >= MIN_LENGTH &&
  value.length <= MAX_ENV_LENGTH &&
  !value.startsWith("/") &&
  !/^[0-9]+$/.test(value) &&
  !["true", "false"].includes(value.toLowerCase()) &&
  !isWeakEnvValue(value);

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
      if (value.length < MIN_LENGTH || value.startsWith("!")) continue;
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
      next = `${stat.mtimeMs}:${stat.size}`;
      if (next === signature) return;
      if (stat.size > MAX_AUTH_BYTES) {
        signature = next;
        fail("too-large");
        return;
      }
      const built = build(env, readFileSync(path, "utf8"));
      signature = next;
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
