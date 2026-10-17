import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A hook on the two calls that make a key durable: what is on disk when the key is linked, and a failure at either step.
const hooks = vi.hoisted(() => ({
  onLink: null as ((from: string, to: string) => void) | null,
  failFsyncAt: 0,
  fsyncs: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (from: string, to: string) => {
      hooks.onLink?.(from, to);
      return actual.linkSync(from, to);
    },
    fsyncSync: (fd: number) => {
      hooks.fsyncs += 1;
      if (hooks.failFsyncAt === hooks.fsyncs) throw Object.assign(new Error("crash"), { code: "EIO" });
      return actual.fsyncSync(fd);
    },
  };
});

import { createVaultStore, VaultError } from "./vault-store.ts";

const ATLAS = { kind: "agent", agentId: "atlas-1a2b" } as const;
const BOLT = { kind: "agent", agentId: "bolt-0001" } as const;
const TEMP = /\.[0-9a-f]{12}\.tmp$/;

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-vault-key-"));
  root = join(dir, "secrets", "vault");
});
afterEach(() => {
  hooks.onLink = null;
  hooks.failFsyncAt = 0;
  hooks.fsyncs = 0;
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

describe("the key is made all or nothing", () => {
  it("is whole in a temporary file before it is linked, and the key path does not exist until then", () => {
    const seen: Array<{ bytes: number; keyThere: boolean }> = [];
    hooks.onLink = (from, to) =>
      void seen.push({ bytes: readFileSync(from).length, keyThere: existsSync(to) });
    const store = createVaultStore(root);
    store.set("u1", ATLAS, "API_TOKEN", "v", 1);
    expect(seen).toEqual([{ bytes: 32, keyThere: false }]);
    expect(readFileSync(join(root, "key")).length).toBe(32);
    expect(readdirSync(root).filter((name) => TEMP.test(name))).toEqual([]);
  });

  it("a crash while the temporary file is made leaves no key, and the next set makes a whole one", () => {
    hooks.failFsyncAt = 1;
    expect(codeOf(() => createVaultStore(root).set("u1", ATLAS, "API_TOKEN", "v", 1))).toContain("crash");
    expect(existsSync(join(root, "key"))).toBe(false);
    hooks.failFsyncAt = 0;
    const again = createVaultStore(root);
    again.set("u1", ATLAS, "API_TOKEN", "v", 2);
    expect(again.reveal("u1", ATLAS)).toEqual({ API_TOKEN: "v" });
  });

  it("a crash after the link (the temporary file still there) leaves a whole key", () => {
    createVaultStore(root).set("u1", ATLAS, "API_TOKEN", "v", 1);
    const key = readFileSync(join(root, "key"));
    writeFileSync(join(root, "key.0123456789ab.tmp"), key, { mode: 0o600 });
    expect(createVaultStore(root).reveal("u1", ATLAS)).toEqual({ API_TOKEN: "v" });
  });
});

describe("crash leftovers", () => {
  it("removes temporary files of the vault folder and of an owner folder at open, and nothing else", () => {
    mkdirSync(join(root, "u1"), { recursive: true, mode: 0o700 });
    const leftovers = [
      join(root, "key.0123456789ab.tmp"),
      join(root, "u1", "agent-atlas-1a2b.json.0123456789ab.tmp"),
    ];
    const kept = [join(root, "key.tmp"), join(root, "u1", "agent-atlas-1a2b.json"), join(root, "notes")];
    for (const path of [...leftovers, ...kept]) writeFileSync(path, "x", { mode: 0o600 });
    createVaultStore(root);
    expect(leftovers.filter(existsSync)).toEqual([]);
    expect(kept.filter(existsSync)).toEqual(kept);
  });

  it("opens a folder that does not exist yet", () => {
    expect(() => createVaultStore(join(dir, "nowhere"))).not.toThrow();
  });
});

describe("a cached key follows its file", () => {
  const made = () => {
    const store = createVaultStore(root);
    store.set("u1", ATLAS, "API_TOKEN", "v", 1);
    return store;
  };

  it("is dropped when the file is gone: reads are unreadable, a write says the key is lost", () => {
    const store = made();
    renameSync(join(root, "key"), join(dir, "key.saved"));
    expect(codeOf(() => store.reveal("u1", ATLAS))).toBe("unreadable");
    expect(codeOf(() => store.names("u1", ATLAS))).toBe("unreadable");
    expect(codeOf(() => store.set("u1", ATLAS, "OTHER", "x", 2))).toBe("key_lost");
    expect(existsSync(join(root, "key"))).toBe(false);
  });

  it("comes back with the file restored", () => {
    const store = made();
    renameSync(join(root, "key"), join(dir, "key.saved"));
    expect(codeOf(() => store.reveal("u1", ATLAS))).toBe("unreadable");
    renameSync(join(dir, "key.saved"), join(root, "key"));
    expect(store.reveal("u1", ATLAS)).toEqual({ API_TOKEN: "v" });
  });

  it("is read again when another file took its place", () => {
    const store = made();
    rmSync(join(root, "key"));
    writeFileSync(join(root, "key"), Buffer.alloc(32, 7), { mode: 0o600 });
    expect(codeOf(() => store.reveal("u1", ATLAS))).toBe("unreadable");
  });
});

describe("a lost key and an empty scope", () => {
  it("lists an empty scope, and a set says the key is lost instead of unreadable", () => {
    const store = createVaultStore(root);
    store.set("u1", ATLAS, "API_TOKEN", "v", 1);
    renameSync(join(root, "key"), join(dir, "key.saved"));
    const again = createVaultStore(root);
    expect(again.names("u1", BOLT)).toEqual([]);
    expect(codeOf(() => again.set("u1", BOLT, "NEW_ONE", "v", 2))).toBe("key_lost");
    expect(existsSync(join(root, "key"))).toBe(false);
  });
});
