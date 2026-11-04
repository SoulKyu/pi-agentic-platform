import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { type AlwaysOnBox, createAlwaysOnKeeper } from "./always-on.ts";

const entry = (id: string, kind: "agent" | "project" = "agent"): AlwaysOnBox => ({
  box: { kind, id },
  ownerId: "o1",
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function build(list: AlwaysOnBox[], start: (entry: AlwaysOnBox) => Promise<void> = async () => {}) {
  const warn = vi.fn();
  const keeper = createAlwaysOnKeeper({ boxes: () => list, start, logger: { warn } });
  return { keeper, warn };
}

describe("the always-on keeper", () => {
  it("boots the listed boxes one at a time, in list order", async () => {
    const log: string[] = [];
    const gates = [deferred(), deferred()];
    let n = 0;
    const { keeper } = build([entry("a"), entry("b")], async (e) => {
      log.push(`begin ${e.box.id}`);
      await gates[n++]?.promise;
      log.push(`end ${e.box.id}`);
    });
    const done = keeper.bootStart();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["begin a"]);
    gates[0]?.resolve();
    await vi.waitFor(() => expect(log).toEqual(["begin a", "end a", "begin b"]));
    gates[1]?.resolve();
    await done;
    expect(log.at(-1)).toBe("end b");
  });

  it("logs a refused start once with its code and still starts the next box", async () => {
    const started: string[] = [];
    const { keeper, warn } = build([entry("a"), entry("b")], async (e) => {
      started.push(e.box.id);
      if (e.box.id === "a") throw new PapError("capacity");
    });
    await keeper.bootStart();
    expect(started).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledExactlyOnceWith("always_on_start_refused", {
      box: "agent:a",
      code: "capacity",
    });
  });

  it("logs a plain error as internal", async () => {
    const { keeper, warn } = build([entry("p", "project")], async () => {
      throw new Error("boom");
    });
    await keeper.bootStart();
    expect(warn).toHaveBeenCalledExactlyOnceWith("always_on_start_refused", {
      box: "project:p",
      code: "internal",
    });
  });

  it("restarts a listed box after an exit and does nothing for an unlisted one", async () => {
    const start = vi.fn(async () => {});
    const { keeper } = build([entry("a")], start);
    keeper.exited({ kind: "agent", id: "b" });
    expect(start).not.toHaveBeenCalled();
    keeper.exited({ kind: "agent", id: "a" });
    expect(start).toHaveBeenCalledExactlyOnceWith(entry("a"));
  });

  it("logs a restart that rejects, without throwing, and does not retry", async () => {
    const start = vi.fn(async () => {
      throw new PapError("capacity");
    });
    const { keeper, warn } = build([entry("a")], start);
    keeper.exited({ kind: "agent", id: "a" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("holds exactly the listed boxes", () => {
    const { keeper } = build([entry("a"), entry("p", "project")]);
    expect(keeper.holds({ kind: "agent", id: "a" })).toBe(true);
    expect(keeper.holds({ kind: "project", id: "p" })).toBe(true);
    expect(keeper.holds({ kind: "project", id: "a" })).toBe(false);
    expect(keeper.holds({ kind: "agent", id: "z" })).toBe(false);
  });

  it("never throws from holds, exited or bootStart when the listing throws, and logs the hold failure once", async () => {
    const warn = vi.fn();
    const start = vi.fn(async () => {});
    const keeper = createAlwaysOnKeeper({
      boxes: () => {
        throw new Error("scan");
      },
      start,
      logger: { warn },
    });
    expect(keeper.holds({ kind: "agent", id: "a" })).toBe(false);
    expect(keeper.holds({ kind: "agent", id: "a" })).toBe(false);
    keeper.exited({ kind: "agent", id: "a" });
    await keeper.bootStart();
    expect(start).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([msg]) => msg === "always_on_hold_failed")).toHaveLength(1);
  });

  it("starts nothing once closed: the boot loop ends and an exit is not answered", async () => {
    const started: string[] = [];
    const gate = deferred();
    const { keeper } = build([entry("a"), entry("b")], async (e) => {
      started.push(e.box.id);
      await gate.promise;
    });
    const done = keeper.bootStart();
    await Promise.resolve();
    keeper.close();
    gate.resolve();
    await done;
    keeper.exited({ kind: "agent", id: "b" });
    await Promise.resolve();
    expect(started).toEqual(["a"]);
  });
});
