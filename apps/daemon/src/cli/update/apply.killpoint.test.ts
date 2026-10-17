import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRelease } from "./apply.ts";
import { harness, type Harness } from "../testing/apply-harness.ts";
import { readPending, type Pending } from "./pending.ts";

const spy = vi.hoisted(() => ({
  app: "",
  atCurrentRename: [] as (string | null)[],
  read: (): string | null => null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (spy.app !== "" && String(to) === `${spy.app}/current`) spy.atCurrentRename.push(spy.read());
      return actual.renameSync(from, to);
    },
  };
});

let h: Harness | undefined;
afterEach(() => {
  spy.app = "";
  spy.atCurrentRename.length = 0;
  h?.cleanup();
});

describe("kill point at the `current` rename (a SIGKILL right after it)", () => {
  it("the journal on disk already names the snapshot when `current` moves", async () => {
    h = harness({ ctl: { migrate: true } });
    const home = h.home;
    spy.app = h.app;
    spy.read = () => {
      const pending = readPending(home);
      return pending === null || pending === "damaged" ? null : (pending as Pending).snapshot;
    };
    await applyRelease(h.deps, "new");
    expect(spy.atCurrentRename).toEqual(["pre-update-new-2026-10-17T10-00-00-000Z.db"]);
  });
});
