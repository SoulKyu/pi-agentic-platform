import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVaultStore, type VaultStore } from "./vault-store.ts";

let dir: string;
let root: string;
let store: VaultStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-vault-drop-"));
  root = join(dir, "vault");
  store = createVaultStore(root);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("VaultStore.dropOwner (A5b)", () => {
  it("removes every scope of the owner, leaves another owner's and the key", () => {
    store.set("m1", { kind: "user" }, "GITHUB_TOKEN", "value-one-1234", 1);
    store.set("m1", { kind: "agent", agentId: "atlas-0001" }, "API_TOKEN", "value-two-1234", 1);
    store.set("m1", { kind: "agent", agentId: "borea-0002" }, "API_TOKEN", "value-three-1234", 1);
    store.set("o1", { kind: "user" }, "GITHUB_TOKEN", "value-owner-1234", 1);
    writeFileSync(join(root, "m1", "user.json.0123456789ab.tmp"), "x");
    store.dropOwner("m1");
    expect(existsSync(join(root, "m1"))).toBe(false);
    expect(store.names("m1", { kind: "user" })).toEqual([]);
    expect(store.reveal("o1", { kind: "user" })).toEqual({ GITHUB_TOKEN: "value-owner-1234" });
    expect(existsSync(join(root, "key"))).toBe(true);
  });

  it("is quiet for an owner with no vault, and refuses an id that is no owner id", () => {
    mkdirSync(root, { recursive: true });
    expect(() => store.dropOwner("nobody")).not.toThrow();
    expect(() => store.dropOwner("../escape")).toThrow();
    expect(existsSync(root)).toBe(true);
  });
});
