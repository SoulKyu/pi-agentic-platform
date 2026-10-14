// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { mount, settle } from "../../testing/dom.ts";
import { dirEntry, filesBed } from "./files-bed.ts";
import { resetFolderMemory } from "./folder-memory.ts";
import { useFolders, type Folders } from "./use-folders.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const NAMES = Array.from({ length: 45 }, (_, index) => `d${index}`);
let latest: Folders;
function Probe() {
  const folders = useFolders("/p", false);
  useEffect(() => {
    latest = folders;
  });
  return null;
}

beforeEach(() => {
  resetFolderMemory();
  const tree: Record<string, ReturnType<typeof dirEntry>[]> = { "/p": NAMES.map((name) => dirEntry(name)) };
  for (const name of NAMES) tree[`/p/${name}`] = [];
  current.runtime = filesBed(tree).runtime;
});

describe("useFolders", () => {
  it("lists again a folder whose listing was evicted from the cache and that is reopened in the same round", async () => {
    await mount(<Probe />);
    await settle();
    for (const name of NAMES) {
      await act(async () => latest.toggle(`/p/${name}`));
      await settle();
    }
    // 45 opened, 20 kept open, 40 listings kept: d0 was forgotten as open and as cached.
    expect(latest.expanded).not.toContain("/p/d0");
    expect(latest.folders.has("/p/d0")).toBe(false);
    await act(async () => latest.toggle("/p/d0"));
    await settle();
    expect(latest.expanded).toContain("/p/d0");
    expect(latest.folders.get("/p/d0")?.status).toBe("ready");
  });
});
