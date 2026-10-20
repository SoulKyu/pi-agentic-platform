import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

const MAX_DEPTH = 8;
const MAX_NODES = 10_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface AuthValues {
  /** Every provider id `auth.json` holds (an OAuth login with no models.json entry included). */
  readonly providers: readonly string[];
  /** Every string value of every credential, nested ones too, whatever its length (the caller applies the floor). */
  readonly values: readonly string[];
}

function strings(node: unknown, out: string[], budget: { nodes: number }, depth: number): void {
  if (budget.nodes-- <= 0 || depth > MAX_DEPTH) throw new Error("auth.json is too large to scan");
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const item of node) strings(item, out, budget, depth + 1);
  else if (typeof node === "object" && node !== null)
    for (const item of Object.values(node)) strings(item, out, budget, depth + 1);
}

/**
 * Pi's reference syntax (AVM-E50), a copy of `isPiReference` in `packages/pi-host/src/policy/secrets.ts` (M5R35; the daemon
 * cannot import pi-host's internals): `$VAR` and `${VAR}` are resolved from the environment, `$$` and `$!` are escaped literals.
 */
const isPiReference = (value: string): boolean => /\$[{A-Za-z_]/.test(value.replace(/\$[$!]/g, ""));

/**
 * A credential's `key` is the one field Pi resolves: a `!command` or a `$VAR` reference holds no value (it is no needle), and an
 * escaped one is the literal Pi resolves it to. Every other field is a literal.
 */
function scannable(credential: unknown): unknown {
  if (typeof credential !== "object" || credential === null || Array.isArray(credential)) return credential;
  const { key, ...rest } = credential as Record<string, unknown>;
  if (typeof key !== "string") return credential;
  if (key.startsWith("!") || isPiReference(key)) return rest;
  return { ...rest, key: key.replace(/\$([$!])/g, "$1") };
}

/**
 * Pi's storage keeps its last good snapshot when auth.json is damaged and lists nothing for it, so a damaged file would read as
 * "no secret". This reads the file once, bounded, only to check that it is, when present, a regular file holding a JSON object
 * (the BOM Pi tolerates included); the parse result is dropped, and every error is a fixed message that quotes nothing.
 * It opens without waiting on a FIFO writer and refuses anything that is not a regular file.
 */
function assertReadable(authPath: string): void {
  let fd: number;
  try {
    fd = openSync(authPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("auth.json cannot be opened", { cause: error });
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("auth.json is not a regular file");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_FILE_BYTES) throw new Error("auth.json is too large to scan");
    }
    const text = buffer.toString("utf8", 0, length).replace(/^\uFEFF/, "");
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new Error("auth.json is not JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("auth.json is not an object");
  } finally {
    closeSync(fd);
  }
}

/**
 * What Pi's own auth storage holds in `<agentDir>/auth.json`: the provider ids come from `ModelRuntime.listCredentials` and each
 * credential from Pi's `readStoredCredential`; the values pap scans for are taken from those, never from the pre-check's parse.
 * A provider that Pi lists and cannot read back is an error, never a skip (fail closed). Every error here is a fixed message:
 * Pi's own can quote the file.
 */
export async function readPiAuth(agentDir: string): Promise<AuthValues> {
  const authPath = join(agentDir, "auth.json");
  assertReadable(authPath);
  const pi = await import("@earendil-works/pi-coding-agent");
  const runtime = await pi.ModelRuntime.create({
    authPath,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const providers = (await runtime.listCredentials()).map((info) => info.providerId);
  const values: string[] = [];
  const budget = { nodes: MAX_NODES };
  for (const providerId of providers) {
    const credential = pi.readStoredCredential(providerId, authPath);
    if (credential === undefined) throw new Error("a credential cannot be read back");
    strings(scannable(credential), values, budget, 0);
  }
  return { providers, values };
}
