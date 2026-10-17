import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `enospc` throws at once; `stall` writes half of the first request, then reports 0 bytes (libuv's short count on a full
// disk or a file-size limit); `chunks` writes 3 bytes at a time, which a correct loop completes.
const injected = vi.hoisted(() => ({ mode: "off" as "off" | "enospc" | "stall" | "chunks", calls: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (fd: number, data: Uint8Array, offset?: number, length?: number) => {
      const start = offset ?? 0;
      const want = length ?? data.length - start;
      if (injected.mode === "enospc")
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      if (injected.mode === "stall") {
        injected.calls += 1;
        return injected.calls > 1 ? 0 : actual.writeSync(fd, data, start, Math.max(1, Math.floor(want / 2)));
      }
      if (injected.mode === "chunks") return actual.writeSync(fd, data, start, Math.min(3, want));
      return actual.writeSync(fd, data, start, want);
    },
  };
});

import {
  createVaultStore,
  VaultError,
  VAULT_LIMITS,
  type VaultScope,
  type VaultStore,
} from "./vault-store.ts";

const agent = (agentId: string): VaultScope => ({ kind: "agent", agentId });
const ATLAS = agent("atlas-1a2b");
const VALUE = "super-secret-value-0f9e8d7c";

let dir: string;
let root: string;
let store: VaultStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-vault-"));
  root = join(dir, "secrets", "vault");
  store = createVaultStore(root);
});
afterEach(() => {
  injected.mode = "off";
  injected.calls = 0;
  rmSync(dir, { recursive: true, force: true });
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof VaultError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};
const mode = (path: string) => statSync(path).mode & 0o777;
const scopeFile = (owner: string, scope: string) => join(root, owner, `${scope}.json`);

describe("round trip and layout", () => {
  it("reveals what was set and lists names and times only", () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 5);
    store.set("u1", ATLAS, "ALPHA", "a", 6);
    expect(store.reveal("u1", ATLAS)).toEqual({ API_TOKEN: VALUE, ALPHA: "a" });
    expect(store.names("u1", ATLAS)).toEqual([
      { name: "ALPHA", updatedAt: 6 },
      { name: "API_TOKEN", updatedAt: 5 },
    ]);
  });

  it("an empty scope reveals nothing", () => {
    expect(store.reveal("u1", ATLAS)).toEqual({});
    expect(store.names("u1", ATLAS)).toEqual([]);
  });

  it("modes: key 0600 and 32 bytes, files 0600, folders 0700", () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    expect(mode(join(root, "key"))).toBe(0o600);
    expect(readFileSync(join(root, "key")).length).toBe(32);
    expect(mode(scopeFile("u1", "agent-atlas-1a2b"))).toBe(0o600);
    expect(mode(root)).toBe(0o700);
    expect(mode(join(root, "u1"))).toBe(0o700);
  });

  it("the value is absent from the file and a rewrite uses a fresh IV", () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    const first = readFileSync(scopeFile("u1", "agent-atlas-1a2b"), "utf8");
    expect(first).not.toContain(VALUE);
    expect(first).not.toContain(Buffer.from(VALUE).toString("base64"));
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 2);
    const second = readFileSync(scopeFile("u1", "agent-atlas-1a2b"), "utf8");
    const iv = (text: string) =>
      (JSON.parse(text) as { entries: { API_TOKEN: { iv: string } } }).entries.API_TOKEN.iv;
    expect(iv(second)).not.toBe(iv(first));
  });

  it("the user scope is separate from an agent's, and owners are separate", () => {
    store.set("u1", { kind: "user" }, "FORGE_TOKEN", "user-value", 1);
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    store.set("u2", ATLAS, "API_TOKEN", "other-owner", 1);
    expect(store.reveal("u1", { kind: "user" })).toEqual({ FORGE_TOKEN: "user-value" });
    expect(store.reveal("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
    expect(store.reveal("u2", ATLAS)).toEqual({ API_TOKEN: "other-owner" });
  });

  it("a second store over the same folder reads the same key", () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    expect(createVaultStore(root).reveal("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
  });

  it("remove deletes one entry and says whether it existed; drop removes the whole file", () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    store.set("u1", ATLAS, "OTHER", "x", 1);
    expect(store.remove("u1", ATLAS, "MISSING")).toBe(false);
    expect(store.remove("u1", ATLAS, "API_TOKEN")).toBe(true);
    expect(store.reveal("u1", ATLAS)).toEqual({ OTHER: "x" });
    store.drop("u1", ATLAS);
    expect(existsSync(scopeFile("u1", "agent-atlas-1a2b"))).toBe(false);
    expect(store.reveal("u1", ATLAS)).toEqual({});
    store.drop("u1", ATLAS);
  });
});

describe("what is refused", () => {
  it("hijack names, bad values and bad ids are bad_request", () => {
    for (const name of [
      "PATH",
      "LD_PRELOAD",
      "GIT_DIR",
      "NODE_OPTIONS",
      "PAP_HOME",
      "HTTPS_PROXY",
      "lower",
      "",
    ])
      expect(
        codeOf(() => store.set("u1", ATLAS, name, "v", 1)),
        name,
      ).toBe("bad_request");
    expect(codeOf(() => store.set("u1", ATLAS, "API_TOKEN", "", 1))).toBe("bad_request");
    expect(codeOf(() => store.set("u1", ATLAS, "API_TOKEN", "a\0b", 1))).toBe("bad_request");
    expect(
      codeOf(() => store.set("u1", ATLAS, "API_TOKEN", "x".repeat(VAULT_LIMITS.valueChars + 1), 1)),
    ).toBe("bad_request");
    expect(codeOf(() => store.set("u1", ATLAS, "API_TOKEN", "x".repeat(VAULT_LIMITS.valueChars), 1))).toBe(
      "no error",
    );
    expect(codeOf(() => store.set("u1", agent("../x"), "API_TOKEN", "v", 1))).toBe("bad_request");
    expect(codeOf(() => store.set("../o", ATLAS, "API_TOKEN", "v", 1))).toBe("bad_request");
    expect(codeOf(() => store.reveal("../o", ATLAS))).toBe("bad_request");
  });

  it("a refused name is never written, to the file or to the key folder", () => {
    expect(codeOf(() => store.set("u1", ATLAS, "LD_PRELOAD", "x", 1))).toBe("bad_request");
    expect(existsSync(root)).toBe(false);
  });

  it("50 entries are held, the 51st is limit_reached, replacing at the cap is allowed", () => {
    for (let n = 0; n < 50; n += 1) store.set("u1", ATLAS, `NAME_${n}`, "v", n);
    expect(codeOf(() => store.set("u1", ATLAS, "ONE_MORE", "v", 99))).toBe("limit_reached");
    expect(codeOf(() => store.set("u1", ATLAS, "NAME_7", "changed", 100))).toBe("no error");
    expect(store.names("u1", ATLAS)).toHaveLength(50);
    expect(store.reveal("u1", ATLAS).NAME_7).toBe("changed");
  });
});

describe("what is unreadable", () => {
  const sealed = () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    return scopeFile("u1", "agent-atlas-1a2b");
  };

  it("a ciphertext moved to another agent's file does not open", () => {
    const from = sealed();
    store.set("u1", agent("bolt-0001"), "OTHER", "x", 1);
    const to = scopeFile("u1", "agent-bolt-0001");
    const stolen = JSON.parse(readFileSync(from, "utf8")) as { entries: Record<string, unknown> };
    writeFileSync(to, JSON.stringify(stolen));
    chmodSync(to, 0o600);
    expect(codeOf(() => store.reveal("u1", agent("bolt-0001")))).toBe("unreadable");
  });

  it("a ciphertext moved to another owner's folder does not open", () => {
    const from = sealed();
    mkdirSync(join(root, "u2"), { mode: 0o700 });
    const to = scopeFile("u2", "agent-atlas-1a2b");
    writeFileSync(to, readFileSync(from));
    chmodSync(to, 0o600);
    expect(codeOf(() => store.reveal("u2", ATLAS))).toBe("unreadable");
  });

  it("a ciphertext renamed inside its file does not open", () => {
    const file = sealed();
    const doc = JSON.parse(readFileSync(file, "utf8")) as { entries: Record<string, unknown> };
    doc.entries.RENAMED = doc.entries.API_TOKEN;
    delete doc.entries.API_TOKEN;
    writeFileSync(file, JSON.stringify(doc));
    expect(codeOf(() => store.reveal("u1", ATLAS))).toBe("unreadable");
  });

  it("one flipped byte does not open", () => {
    const file = sealed();
    const doc = JSON.parse(readFileSync(file, "utf8")) as { entries: { API_TOKEN: { ct: string } } };
    const bytes = Buffer.from(doc.entries.API_TOKEN.ct, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    doc.entries.API_TOKEN.ct = bytes.toString("base64");
    writeFileSync(file, JSON.stringify(doc));
    expect(codeOf(() => store.reveal("u1", ATLAS))).toBe("unreadable");
  });

  it("a group-readable file is unreadable", () => {
    const file = sealed();
    chmodSync(file, 0o640);
    expect(codeOf(() => store.reveal("u1", ATLAS))).toBe("unreadable");
    expect(codeOf(() => store.names("u1", ATLAS))).toBe("unreadable");
  });

  it("a symlink in place of the file is unreadable, whatever it points at", () => {
    const file = sealed();
    const target = join(dir, "elsewhere.json");
    renameSync(file, target);
    symlinkSync(target, file);
    expect(codeOf(() => store.reveal("u1", ATLAS))).toBe("unreadable");
  });

  it("a symlink in place of the key is unreadable", () => {
    sealed();
    const target = join(dir, "key-elsewhere");
    renameSync(join(root, "key"), target);
    symlinkSync(target, join(root, "key"));
    expect(codeOf(() => createVaultStore(root).reveal("u1", ATLAS))).toBe("unreadable");
  });

  it("a short key is unreadable and is never replaced", () => {
    sealed();
    writeFileSync(join(root, "key"), Buffer.alloc(16), { mode: 0o600 });
    expect(codeOf(() => createVaultStore(root).reveal("u1", ATLAS))).toBe("unreadable");
    expect(readFileSync(join(root, "key")).length).toBe(16);
  });

  it("garbled JSON or entries of the wrong shape are unreadable", () => {
    const file = sealed();
    writeFileSync(file, "{not json");
    expect(codeOf(() => store.names("u1", ATLAS))).toBe("unreadable");
    writeFileSync(file, JSON.stringify({ v: 1, entries: { API_TOKEN: null } }));
    expect(codeOf(() => store.names("u1", ATLAS))).toBe("unreadable");
    writeFileSync(file, JSON.stringify({ v: 2, entries: {} }));
    expect(codeOf(() => store.names("u1", ATLAS))).toBe("unreadable");
  });

  it("a file over the size cap is unreadable", () => {
    const file = sealed();
    writeFileSync(file, " ".repeat(VAULT_LIMITS.fileBytes + 1));
    expect(codeOf(() => store.reveal("u1", ATLAS))).toBe("unreadable");
  });
});

describe("a lost key (RT-15)", () => {
  const lose = () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    renameSync(join(root, "key"), join(dir, "key.saved"));
  };

  it("reveal, names and set are unreadable and no new key is made, also for another agent's empty scope", () => {
    lose();
    const again = createVaultStore(root);
    for (const scope of [ATLAS, agent("bolt-0001")]) {
      expect(codeOf(() => again.reveal("u1", scope))).toBe(scope === ATLAS ? "unreadable" : "no error");
    }
    expect(codeOf(() => again.names("u1", ATLAS))).toBe("unreadable");
    expect(codeOf(() => again.set("u1", ATLAS, "NEW_ONE", "v", 2))).toBe("key_lost");
    expect(codeOf(() => again.set("u1", agent("bolt-0001"), "NEW_ONE", "v", 2))).toBe("key_lost");
    expect(existsSync(join(root, "key"))).toBe(false);
  });

  it("the key restored opens again", () => {
    lose();
    renameSync(join(dir, "key.saved"), join(root, "key"));
    expect(createVaultStore(root).reveal("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
  });

  it("the vault folder removed: a set starts over with a new key", () => {
    lose();
    rmSync(root, { recursive: true });
    const fresh = createVaultStore(root);
    fresh.set("u1", ATLAS, "API_TOKEN", "again", 3);
    expect(fresh.reveal("u1", ATLAS)).toEqual({ API_TOKEN: "again" });
  });

  it("a fresh vault: the first set makes the key", () => {
    expect(existsSync(join(root, "key"))).toBe(false);
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    expect(existsSync(join(root, "key"))).toBe(true);
  });

  it("reading an empty scope of a fresh vault makes no key", () => {
    store.reveal("u1", ATLAS);
    store.names("u1", ATLAS);
    expect(existsSync(join(root, "key"))).toBe(false);
  });
});

describe("writes are all or nothing", () => {
  it("leaves no temporary file behind", () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    store.set("u1", ATLAS, "API_TOKEN", "again", 2);
    expect(readdirSync(join(root, "u1"))).toEqual(["agent-atlas-1a2b.json"]);
  });

  it("a full disk keeps the old file and leaves no temporary file", () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    const before = readFileSync(scopeFile("u1", "agent-atlas-1a2b"), "utf8");
    injected.mode = "enospc";
    expect(codeOf(() => store.set("u1", ATLAS, "OTHER", "x", 2))).toContain("no space left");
    injected.mode = "off";
    expect(readFileSync(scopeFile("u1", "agent-atlas-1a2b"), "utf8")).toBe(before);
    expect(readdirSync(join(root, "u1"))).toEqual(["agent-atlas-1a2b.json"]);
    expect(store.reveal("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
  });

  it("a full disk while the key is made leaves no half key: the next set makes a whole one", () => {
    injected.mode = "enospc";
    expect(codeOf(() => store.set("u1", ATLAS, "API_TOKEN", VALUE, 1))).not.toBe("no error");
    injected.mode = "off";
    expect(existsSync(join(root, "key"))).toBe(false);
    const again = createVaultStore(root);
    again.set("u1", ATLAS, "API_TOKEN", VALUE, 2);
    expect(again.reveal("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
  });

  it("a short write on a full disk fails the set and leaves the old file and its values readable (I2)", () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    const before = readFileSync(scopeFile("u1", "agent-atlas-1a2b"), "utf8");
    injected.mode = "stall";
    expect(codeOf(() => store.set("u1", ATLAS, "OTHER", "x".repeat(200), 2))).toContain("other:");
    injected.mode = "off";
    expect(readFileSync(scopeFile("u1", "agent-atlas-1a2b"), "utf8")).toBe(before);
    expect(readdirSync(join(root, "u1"))).toEqual(["agent-atlas-1a2b.json"]);
    expect(createVaultStore(root).reveal("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
  });

  it("a short write while the key is made leaves no key and no scope file (I2)", () => {
    injected.mode = "stall";
    expect(codeOf(() => store.set("u1", ATLAS, "API_TOKEN", VALUE, 1))).not.toBe("no error");
    injected.mode = "off";
    expect(existsSync(join(root, "key"))).toBe(false);
    expect(existsSync(scopeFile("u1", "agent-atlas-1a2b"))).toBe(false);
    const again = createVaultStore(root);
    again.set("u1", ATLAS, "API_TOKEN", VALUE, 2);
    expect(again.reveal("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
  });

  it("partial writes that make progress are completed: the whole file and key land (I2)", () => {
    injected.mode = "chunks";
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    injected.mode = "off";
    expect(readFileSync(join(root, "key")).length).toBe(32);
    expect(createVaultStore(root).reveal("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
  });

  it("errors carry a code, never a value", () => {
    store.set("u1", ATLAS, "API_TOKEN", VALUE, 1);
    const file = scopeFile("u1", "agent-atlas-1a2b");
    chmodSync(file, 0o644);
    try {
      store.reveal("u1", ATLAS);
    } catch (error) {
      expect(String((error as Error).message)).toBe("vault: unreadable");
    }
  });
});
