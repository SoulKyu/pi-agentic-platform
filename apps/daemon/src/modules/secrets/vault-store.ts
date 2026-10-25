import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isVaultName, VAULT_CAPS, VaultValue } from "@pap/contracts";
import { dropOwnerFolder } from "./vault-drop.ts";

/** `user` (M14's per-user forge token, never given to an agent) or one agent's vault. */
export type VaultScope = { readonly kind: "user" } | { readonly kind: "agent"; readonly agentId: string };

/** The caps of the contract's `VaultValue` and `VaultValues`, and this store's file size. */
export const VAULT_LIMITS = {
  entriesPerScope: VAULT_CAPS.names,
  valueChars: VAULT_CAPS.valueChars,
  fileBytes: 1_048_576,
} as const;

const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type VaultErrorCode = "unreadable" | "key_lost" | "limit_reached" | "bad_request";
/** The message is the code: no value, key, ciphertext or path ever reaches an error. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode) {
    super(`vault: ${code}`);
    this.name = "VaultError";
    this.code = code;
  }
}

interface Sealed {
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
  readonly at: number;
}
type Document = { v: 1; entries: Record<string, Sealed> };

const scopeName = (scope: VaultScope): string => {
  if (scope.kind === "user") return "user";
  if (!AGENT_ID.test(scope.agentId)) throw new VaultError("bad_request");
  return `agent-${scope.agentId}`;
};

/** Binds a ciphertext to its owner, scope and name: moved to another slot, it does not open (GCM tag mismatch). */
const aadOf = (ownerId: string, scope: string, name: string): Buffer =>
  Buffer.from(`pap-vault-v1\u0000${ownerId}\u0000${scope}\u0000${name}`, "utf8");

const isSealed = (value: unknown): value is Sealed => {
  const entry = value as Partial<Record<keyof Sealed, unknown>> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.iv === "string" &&
    typeof entry.tag === "string" &&
    typeof entry.ct === "string" &&
    typeof entry.at === "number"
  );
};

/** A private regular file of ours, read whole without following a link; null when missing; `unreadable` otherwise. */
function readPrivate(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new VaultError("unreadable");
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > maxBytes
    )
      throw new VaultError("unreadable");
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Writes every byte or throws: `writeSync` may report fewer bytes than asked on a full disk or a size limit, without an error. */
function writeAll(fd: number, data: Buffer): void {
  let written = 0;
  while (written < data.length) {
    const n = writeSync(fd, data, written, data.length - written);
    if (n <= 0) throw Object.assign(new Error("short write"), { code: "EIO" });
    written += n;
  }
}

/** Temp file (0600, `wx`), fsync, rename over the target, fsync the folder: a crash leaves the old file or the new one. */
function writePrivate(dir: string, name: string, data: Buffer): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeAll(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  fsyncDir(dir);
}

function fsyncDir(dir: string): void {
  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** What `writePrivate` and the key's creation name their temporary files: `<file>.<12 hex>.tmp`. */
const TEMP_FILE = /\.[0-9a-f]{12}\.tmp$/;

/** A crash between a temporary file and its rename leaves it behind: removed at open, from the vault and owner folders. */
function sweepTemps(root: string): void {
  const removeIn = (dir: string, onFolder: (name: string) => void): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && TEMP_FILE.test(entry.name)) rmSync(join(dir, entry.name), { force: true });
      else if (entry.isDirectory()) onFolder(entry.name);
    }
  };
  removeIn(root, (name) => {
    if (OWNER_ID.test(name)) removeIn(join(root, name), () => undefined);
  });
}

/** True when some owner's scope file exists: its entries were sealed with the key (RT-15). */
function holdsSealedFiles(root: string): boolean {
  try {
    const owners: Dirent[] = readdirSync(root, { withFileTypes: true });
    return owners.some(
      (owner) =>
        owner.isDirectory() &&
        OWNER_ID.test(owner.name) &&
        readdirSync(join(root, owner.name)).some((name) => name.endsWith(".json")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new VaultError("unreadable");
  }
}

/**
 * `$PAP_HOME/secrets/vault/key`: 32 random bytes made once (`wx`), never replaced; a damaged key is `unreadable`. A
 * missing key is made only while no scope file exists: a new key would never open entries sealed with the lost one and
 * would mix two keys in one file, so a lost key leaves the vault `unreadable` until the owner restores the key file or
 * removes the vault folder (no key rotation in M11: ADR 0049).
 */
function loadKey(root: string): Buffer {
  const path = join(root, "key");
  const existing = readPrivate(path, KEY_BYTES);
  if (existing !== null) {
    if (existing.length !== KEY_BYTES) throw new VaultError("unreadable");
    return existing;
  }
  if (holdsSealedFiles(root)) throw new VaultError("unreadable");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  // The key path never holds a partial key: a whole temporary file is linked to it (`link` fails when the key exists).
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeAll(fd, key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Needs hard links: Linux only (pap targets Linux), the vault fails to open on a file system without them.
    linkSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another writer made it first (a second daemon cannot run: pap.lock); read what is there.
    const again = readPrivate(path, KEY_BYTES);
    if (again === null || again.length !== KEY_BYTES) throw new VaultError("unreadable");
    return again;
  }
  rmSync(temp, { force: true });
  fsyncDir(root);
  return key;
}

/** Which file a cached key came from: a key whose file is gone, or replaced, is read again. */
const stampOf = (path: string): string | null => {
  try {
    const stat = lstatSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
};

export interface VaultStore {
  names(ownerId: string, scope: VaultScope): { name: string; updatedAt: number }[];
  /** The values of one scope, for the daemon only (a worker's sandbox env, M14's forge call). Never sent to a client. */
  reveal(ownerId: string, scope: VaultScope): Record<string, string>;
  set(ownerId: string, scope: VaultScope, name: string, value: string, now: number): void;
  remove(ownerId: string, scope: VaultScope, name: string): boolean;
  /** An agent deleted or quarantined: its whole file goes. */
  drop(ownerId: string, scope: VaultScope): void;
  /** A member deleted: every scope of the owner, whatever their names. */
  dropOwner(ownerId: string): void;
  /** Every value of every owner and scope, for the daemon's own secret scans only (T15b). Never logged, never sent. */
  everyValue(): string[];
  /** Every value of one owner's scopes (the profile scan of the install's owner). Throws when a file is unreadable. */
  valuesOf(ownerId: string): string[];
  /** The owners that keep a vault folder. */
  ownerIds(): string[];
}

export function createVaultStore(root: string, options: { sweep?: boolean } = {}): VaultStore {
  if (options.sweep !== false) sweepTemps(root);
  let cached: { readonly key: Buffer; readonly stamp: string | null } | null = null;
  const keyPath = join(root, "key");
  const keyOf = (): Buffer => {
    if (cached !== null && cached.stamp !== null && cached.stamp === stampOf(keyPath)) return cached.key;
    cached = null;
    const key = loadKey(root);
    cached = { key, stamp: stampOf(keyPath) };
    return key;
  };
  const dirOf = (ownerId: string): string => {
    if (!OWNER_ID.test(ownerId)) throw new VaultError("bad_request");
    return join(root, ownerId);
  };
  function load(ownerId: string, scope: string): Document {
    const raw = readPrivate(join(dirOf(ownerId), `${scope}.json`), VAULT_LIMITS.fileBytes);
    if (raw === null) return { v: 1, entries: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new VaultError("unreadable");
    }
    const doc = parsed as Partial<Document> | null;
    if (
      !doc ||
      doc.v !== 1 ||
      typeof doc.entries !== "object" ||
      doc.entries === null ||
      Array.isArray(doc.entries) ||
      !Object.values(doc.entries).every(isSealed)
    )
      throw new VaultError("unreadable");
    return doc as Document;
  }
  const save = (ownerId: string, scope: string, doc: Document): void =>
    writePrivate(dirOf(ownerId), `${scope}.json`, Buffer.from(JSON.stringify(doc), "utf8"));
  function seal(ownerId: string, scope: string, name: string, value: string, now: number): Sealed {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", keyOf(), iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadOf(ownerId, scope, name));
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
      at: now,
    };
  }
  function open(ownerId: string, scope: string, name: string, sealed: Sealed): string {
    try {
      const iv = Buffer.from(sealed.iv, "base64");
      const tag = Buffer.from(sealed.tag, "base64");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("shape");
      const decipher = createDecipheriv("aes-256-gcm", keyOf(), iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aadOf(ownerId, scope, name));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      throw new VaultError("unreadable");
    }
  }
  return {
    names(ownerId, scope) {
      const doc = load(ownerId, scopeName(scope));
      // Entries that no key can open are not listed as if they could be (RT-15): a lost key is `unreadable` here too.
      if (Object.keys(doc.entries).length > 0) keyOf();
      return Object.entries(doc.entries)
        .filter(([name]) => isVaultName(name))
        .map(([name, sealed]) => ({ name, updatedAt: sealed.at }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    reveal(ownerId, scope) {
      const name = scopeName(scope);
      const doc = load(ownerId, name);
      const values: Record<string, string> = {};
      for (const [entry, sealed] of Object.entries(doc.entries))
        if (isVaultName(entry)) values[entry] = open(ownerId, name, entry, sealed);
      return values;
    },
    set(ownerId, scope, name, value, now) {
      if (!isVaultName(name) || !VaultValue.safeParse(value).success) throw new VaultError("bad_request");
      const scopeKey = scopeName(scope);
      const doc = load(ownerId, scopeKey);
      if (!(name in doc.entries) && Object.keys(doc.entries).length >= VAULT_LIMITS.entriesPerScope)
        throw new VaultError("limit_reached");
      try {
        keyOf();
      } catch (error) {
        // The key file is gone while entries sealed with it are not: said apart from a damaged file.
        if (error instanceof VaultError && stampOf(keyPath) === null) throw new VaultError("key_lost");
        throw error;
      }
      doc.entries[name] = seal(ownerId, scopeKey, name, value, now);
      save(ownerId, scopeKey, doc);
    },
    remove(ownerId, scope, name) {
      const scopeKey = scopeName(scope);
      const doc = load(ownerId, scopeKey);
      if (!(name in doc.entries)) return false;
      doc.entries = Object.fromEntries(Object.entries(doc.entries).filter(([entry]) => entry !== name));
      save(ownerId, scopeKey, doc);
      return true;
    },
    drop(ownerId, scope) {
      rmSync(join(dirOf(ownerId), `${scopeName(scope)}.json`), { force: true });
    },
    dropOwner: (ownerId) => dropOwnerFolder(dirOf(ownerId)),
    ownerIds() {
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((owner) => owner.isDirectory() && OWNER_ID.test(owner.name))
          .map((owner) => owner.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new VaultError("unreadable");
      }
    },
    valuesOf(ownerId) {
      const values: string[] = [];
      let files: string[];
      try {
        files = readdirSync(dirOf(ownerId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return values;
        throw new VaultError("unreadable");
      }
      for (const file of files) {
        const scope = /^(user|agent-[a-z0-9][a-z0-9-]{0,47})\.json$/.exec(file)?.[1];
        if (scope === undefined) continue;
        const doc = load(ownerId, scope);
        for (const [name, sealed] of Object.entries(doc.entries))
          if (isVaultName(name)) values.push(open(ownerId, scope, name, sealed));
      }
      return values;
    },
    everyValue() {
      return this.ownerIds().flatMap((owner) => this.valuesOf(owner));
    },
  };
}
