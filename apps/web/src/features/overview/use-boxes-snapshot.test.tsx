// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { box, memberSnapshot, ownerSnapshot } from "./overview-fixtures.ts";
import { useBoxesSnapshot } from "./use-boxes-snapshot.ts";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

function Probe({ onValue }: { onValue(value: ReturnType<typeof useBoxesSnapshot>): void }) {
  onValue(useBoxesSnapshot());
  return null;
}

interface Gate {
  readonly promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}
const gate = (): Gate => {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};

let bed: ReturnType<typeof fakeRuntime>;
let latest: ReturnType<typeof useBoxesSnapshot>;
const seen = (value: ReturnType<typeof useBoxesSnapshot>) => {
  latest = value;
};
const reads = () => bed.called("overview.get").length;
const tick = async () => {
  await act(async () => {
    bed.emitTo("subscribe.overview", { kind: "changed" });
  });
};
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});

describe("useBoxesSnapshot", () => {
  it("reads once on mount and parses the snapshot", async () => {
    bed.handlers["overview.get"] = () => ownerSnapshot();
    await mount(<Probe onValue={seen} />);
    await settle();
    expect(reads()).toBe(1);
    expect(latest.snapshot?.boxes[0]?.name).toBe("Atlas");
    expect(latest.failed).toBe(false);
  });

  it("a tick reads again, and a second tick during that read reads once more after it, not twice", async () => {
    const pending: Gate[] = [];
    bed.handlers["overview.get"] = () => {
      const next = gate();
      pending.push(next);
      return next.promise;
    };
    await mount(<Probe onValue={seen} />);
    expect(reads()).toBe(1);
    pending[0]?.resolve(ownerSnapshot());
    await settle();
    await tick();
    expect(reads()).toBe(2);
    await tick();
    await tick();
    expect(reads()).toBe(2);
    pending[1]?.resolve(ownerSnapshot());
    await settle();
    expect(reads()).toBe(3);
    pending[2]?.resolve(ownerSnapshot());
    await settle();
    expect(reads()).toBe(3);
  });

  it("a failed re-read keeps the last snapshot and says so; the next good read clears it", async () => {
    let answer: () => unknown = () => ownerSnapshot();
    bed.handlers["overview.get"] = () => answer();
    await mount(<Probe onValue={seen} />);
    await settle();
    answer = () => Promise.reject(new Error("down"));
    await tick();
    await settle();
    expect(latest.snapshot?.boxes).toHaveLength(1);
    expect(latest.failed).toBe(true);
    answer = () => ownerSnapshot({ boxes: [] });
    await tick();
    await settle();
    expect(latest.failed).toBe(false);
    expect(latest.snapshot?.boxes).toHaveLength(0);
  });

  it("a first read that fails leaves no snapshot and failed", async () => {
    bed.handlers["overview.get"] = () => Promise.reject(new Error("down"));
    await mount(<Probe onValue={seen} />);
    await settle();
    expect(latest.snapshot).toBeNull();
    expect(latest.failed).toBe(true);
  });

  it("an answer that is not a snapshot counts as a failed read", async () => {
    bed.handlers["overview.get"] = () => ({ nope: true });
    await mount(<Probe onValue={seen} />);
    await settle();
    expect(latest.snapshot).toBeNull();
    expect(latest.failed).toBe(true);
  });

  it("an older read that answers last never replaces a newer one (reload supersedes)", async () => {
    const pending: Gate[] = [];
    bed.handlers["overview.get"] = () => {
      const next = gate();
      pending.push(next);
      return next.promise;
    };
    await mount(<Probe onValue={seen} />);
    expect(reads()).toBe(1);
    await act(async () => latest.reload());
    expect(reads()).toBe(2);
    pending[1]?.resolve(memberSnapshot({ boxes: [box({ name: "Newer" })] }));
    await settle();
    pending[0]?.resolve(ownerSnapshot({ boxes: [box({ name: "Older" })] }));
    await settle();
    expect(latest.snapshot?.boxes[0]?.name).toBe("Newer");
  });
});
