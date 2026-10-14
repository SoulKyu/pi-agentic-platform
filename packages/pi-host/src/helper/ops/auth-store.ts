import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { stripBom } from "../jsonc.ts";
import { HelperOpError } from "../ops.ts";
import { PiFileRefused, readPiFile, writePiFile } from "../pi-file.ts";

/** Pi's own lock protocol (proper-lockfile): a `<file>.lock` folder, stale after 30 s. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;
const LOCK_TRIES = 100;

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** The helper error a Pi-file refusal stands for; a hard link has its own code so the client can say why (R66). */
export const refusal = (error: PiFileRefused): HelperOpError =>
  new HelperOpError(error.reason === "hard-link" ? "config_hard_link" : "config_path_refused", error.reason);

/** The helper error hiding in `error` or in the causes Pi wraps it in, or null. Provider text is never carried over. */
export function helperErrorOf(error: unknown): HelperOpError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    if (current instanceof HelperOpError) return current;
    if (current instanceof PiFileRefused) return refusal(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const credentialOf = (value: unknown): Credential | undefined =>
  isRecord(value) && (value.type === "api_key" || value.type === "oauth")
    ? (value as unknown as Credential)
    : undefined;

/** Pi runs a stored value that starts with `!` as a shell command: pap never writes one (owner c3). */
function refuseCommands(credential: Credential): void {
  if (credential.type !== "api_key") return;
  const values = [credential.key, ...Object.values(credential.env ?? {})];
  if (values.some((value) => typeof value === "string" && value.startsWith("!")))
    throw new HelperOpError("bad_params", "a credential cannot be a command");
}

/** Takes Pi's `<file>.lock` folder (also used for settings.json); the returned function releases it. */
export async function acquire(lock: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      // A release that fails leaves a folder that goes stale in 30 s; nothing else can be done about it here.
      return () => fs.rmdir(lock).catch(() => undefined);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    const info = await fs.lstat(lock).catch(() => null);
    if (info !== null && !info.isDirectory()) throw new HelperOpError("config_path_refused", "not-a-file");
    if (info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS)
      await fs.rmdir(lock).catch(() => undefined);
    else await sleep(LOCK_WAIT_MS);
  }
  throw new HelperOpError("failed", `${basename(lock, ".lock")} is locked`);
}

/**
 * Pi's credential store over the Pi file boundary (Task 6b): every read and write of auth.json is judged by
 * `readPiFile` / `writePiFile` (inside the folders, no link, regular file, no other hard link), a write is atomic and
 * leaves mode 0600, and a modification holds Pi's own lock folder so two processes do not lose each other's entry.
 * `read` returns what is stored: a `!command` key is not resolved here, or anywhere in this module.
 */
export function createAuthFileStore(where: {
  readonly agentDir: string;
  readonly home: string;
}): CredentialStore {
  const path = join(where.agentDir, "auth.json");
  const roots = [where.agentDir, where.home];

  async function load(): Promise<Record<string, unknown>> {
    let text: string | null;
    try {
      ({ text } = await readPiFile(path, roots));
    } catch (error) {
      throw error instanceof PiFileRefused ? refusal(error) : error;
    }
    if (text === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(text));
    } catch {
      throw new HelperOpError("config_invalid", "auth.json");
    }
    if (!isRecord(parsed)) throw new HelperOpError("config_invalid", "auth.json");
    return parsed;
  }

  async function save(data: Record<string, unknown>): Promise<void> {
    try {
      await writePiFile(path, `${JSON.stringify(data, null, 2)}\n`, {
        roots,
        mode: 0o600,
        keepMode: false,
        onFolderSyncFailed: (code) =>
          process.stderr.write(
            `pap-helper: auth.json folder sync failed (${/^[A-Z0-9_]{1,16}$/.test(code) ? code : "UNKNOWN"})\n`,
          ),
      });
    } catch (error) {
      throw error instanceof PiFileRefused ? refusal(error) : error;
    }
  }

  async function locked<T>(task: () => Promise<T>): Promise<T> {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const release = await acquire(`${path}.lock`);
    try {
      return await task();
    } finally {
      await release();
    }
  }

  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      return credentialOf((await load())[providerId]);
    },
    async list(options): Promise<readonly CredentialInfo[]> {
      options?.signal?.throwIfAborted();
      return Object.entries(await load()).flatMap(([providerId, value]) => {
        const credential = credentialOf(value);
        return credential ? [{ providerId, type: credential.type }] : [];
      });
    },
    async modify(providerId, fn, options) {
      options?.signal?.throwIfAborted();
      return locked(async () => {
        const data = await load();
        const current = credentialOf(data[providerId]);
        const next = await fn(current);
        if (next === undefined) return current;
        refuseCommands(next);
        await save({ ...data, [providerId]: next });
        return next;
      });
    },
    async delete(providerId, options) {
      options?.signal?.throwIfAborted();
      await locked(async () => {
        const data = await load();
        if (!Object.hasOwn(data, providerId)) return;
        await save(Object.fromEntries(Object.entries(data).filter(([id]) => id !== providerId)));
      });
    },
  };
}
