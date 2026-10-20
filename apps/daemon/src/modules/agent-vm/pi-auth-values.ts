import { readFileSync, statSync } from "node:fs";
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
 * Pi's storage keeps its last good snapshot when auth.json is damaged and lists nothing for it, so a damaged file would read as
 * "no secret". This only checks that the file is, when present, a JSON object of a bounded size; no value is taken from it here.
 */
function assertReadable(authPath: string): void {
  let size: number;
  try {
    size = statSync(authPath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (size > MAX_FILE_BYTES) throw new Error("auth.json is too large to scan");
  const parsed: unknown = size === 0 ? {} : JSON.parse(readFileSync(authPath, "utf8").replace(/^\uFEFF/, ""));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("auth.json is not an object");
}

/**
 * What Pi's own auth storage holds in `<agentDir>/auth.json`: the provider ids come from `ModelRuntime.listCredentials` (which
 * throws on a file Pi cannot read) and each credential from Pi's `readStoredCredential`, so pap parses nothing itself. A provider
 * that Pi lists and cannot read back is an error, never a skip (fail closed). Errors carry no message of Pi's: it may quote the file.
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
    strings(credential, values, budget, 0);
  }
  return { providers, values };
}
