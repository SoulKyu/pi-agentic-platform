import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../../kernel/logger.ts";
import { writeExclusive } from "./secret-file.ts";

export interface VapidIdentity {
  /** base64url of the 65-byte uncompressed point */
  readonly publicKey: string;
  readonly keyId: string;
  /** "t=<jwt>, k=<pub>"; a token is reused per audience and subject for 6 h (M12R5) */
  sign(audience: string, subject: string, nowMs: number): string;
}
export type VapidState =
  { kind: "ready"; identity: VapidIdentity; minted: boolean } | { kind: "off"; reason: "keys_unreadable" };

const b64u = (b: Buffer) => b.toString("base64url");
const FILE = "vapid.json";
const STALE_TMP = /^vapid\.json\.[0-9a-f]{16}\.tmp$/;
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unknown";

const MAX_BYTES = 4096;
const STALE_TMP_MS = 60_000;
const PROBE = Buffer.from("pap-vapid-probe");
const ownerOk = (uid: number) => process.getuid === undefined || uid === process.getuid();

type Read = { key: KeyObject } | { reason: string };

/** A reason (a class, never content) when damaged, a link, not ours, not a regular 0600 file, too big or inconsistent. It never "fixes" anything. */
function readKey(path: string): Read {
  let fd = -1;
  try {
    // O_NONBLOCK: a FIFO at the path must not hang the boot; O_NOFOLLOW: a symlink fails here
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { reason: "not_file" };
    if ((stats.mode & 0o777) !== 0o600) return { reason: "open_mode" };
    if (!ownerOk(stats.uid)) return { reason: "owner" };
    if (stats.size > MAX_BYTES) return { reason: "too_big" };
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as { v?: number; privateJwk?: unknown };
    if (parsed.v !== 1 || typeof parsed.privateJwk !== "object" || parsed.privateJwk === null)
      return { reason: "parse" };
    const key = createPrivateKey({ key: parsed.privateJwk as never, format: "jwk" });
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return { reason: "parse" };
    // d must belong to the public point: a flipped, empty or foreign scalar would sign JWTs every push service rejects
    const probe = sign("sha256", PROBE, { key, dsaEncoding: "ieee-p1363" });
    const consistent = verify(
      "sha256",
      PROBE,
      { key: createPublicKey(key), dsaEncoding: "ieee-p1363" },
      probe,
    );
    return consistent ? { key } : { reason: "key_mismatch" };
  } catch (error) {
    return { reason: codeOf(error) === "ELOOP" ? "link" : "parse" };
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** Never throws. Only a missing file mints a key (M12R4). */
export function loadVapid(secretsDir: string, logger: Logger): VapidState {
  const dir = join(secretsDir, "push");
  const path = join(dir, FILE);
  try {
    let dirStats = lstatOrNull(dir);
    if (dirStats === null) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700); // we just made it: the umask cannot leave it wider
      dirStats = lstatSync(dir);
    }
    if (!dirStats.isDirectory()) return off(logger, "link");
    if ((dirStats.mode & 0o777) !== 0o700) return off(logger, "open_mode"); // an existing folder is never "fixed"
    if (!ownerOk(dirStats.uid)) return off(logger, "owner");
    const fileStats = lstatOrNull(path);
    if (fileStats !== null) {
      const existing = readKey(path); // lstat above is only for "does it exist"; readKey refuses links, non-files and open modes
      return "key" in existing ? ready(existing.key, false) : off(logger, existing.reason); // never mint over a file that exists
    }
    for (const name of readdirSync(dir)) if (STALE_TMP.test(name)) tryUnlinkStale(join(dir, name)); // leftovers of a crash
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const created = writeExclusive(
      path,
      JSON.stringify({ v: 1, privateJwk: privateKey.export({ format: "jwk" }) }),
    );
    if (created) return ready(privateKey, true);
    const winner = readKey(path); // another process created it between our check and our link: use its key
    return "key" in winner ? ready(winner.key, false) : off(logger, winner.reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return off(logger, message === "vapid_point" ? "vapid_point" : `io_${codeOf(error)}`); // push is off with a reason; the daemon still boots
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}
function tryUnlinkStale(path: string) {
  try {
    const stats = lstatSync(path);
    // a fresh file may be a concurrent writer's temporary: only old leftovers go
    if (stats.isFile() && Date.now() - stats.mtimeMs > STALE_TMP_MS) unlinkSync(path);
  } catch {
    /* best effort: a failed cleanup only leaves a leftover; the load goes on */
  }
}
function off(logger: Logger, reason: string): VapidState {
  logger.warn("push_vapid_unreadable", { reason }); // the reason class only, never the content
  return { kind: "off", reason: "keys_unreadable" };
}
function ready(key: KeyObject, minted: boolean): VapidState {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
  if (point.length !== 65) throw new Error("vapid_point");
  const publicKey = b64u(point);
  const keyId = createHash("sha256").update(point).digest("hex").slice(0, 16);
  return {
    kind: "ready",
    minted,
    identity: {
      publicKey,
      keyId,
      sign: cachedSigner((audience, subject, nowMs) => signVapid(key, publicKey, audience, subject, nowMs)),
    },
  };
}
const CACHE_MS = 6 * 3600_000; // a cached token keeps at least 6 h of its 12 h life
const CACHE_MAX = 32;
/** One token per audience and subject for 6 h; a clock that went backwards signs again. Bounded: full means start over. */
function cachedSigner(
  signFresh: (audience: string, subject: string, nowMs: number) => string,
): VapidIdentity["sign"] {
  const cache = new Map<string, { at: number; header: string }>();
  return (audience, subject, nowMs) => {
    const cacheKey = `${audience}\n${subject}`;
    const hit = cache.get(cacheKey);
    if (hit && nowMs >= hit.at && nowMs - hit.at < CACHE_MS) return hit.header;
    const header = signFresh(audience, subject, nowMs);
    if (!cache.has(cacheKey) && cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, { at: nowMs, header });
    return header;
  };
}
function signVapid(key: KeyObject, pub: string, aud: string, sub: string, nowMs: number): string {
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub })));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `t=${head}.${body}.${b64u(sig)}, k=${pub}`;
}
