import { describe, expect, it } from "vitest";
import { createSubagentService } from "./service.ts";
import { createSubagentStop } from "./stop.ts";
import { createSubagentStore } from "./store.ts";
import { bed as makeBed, type Options, settle } from "./testing/service-bed.ts";

const bed = (options?: Options) =>
  makeBed({ createSubagentService, createSubagentStop, createSubagentStore }, options);

describe("a finished child gives its worker back (review I2)", () => {
  it("releases the idle worker once the answer is read", async () => {
    const b = bed();
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    expect(b.sessions.releaseIdle).not.toHaveBeenCalled();
    b.finish("child-1");
    await call;
    expect(b.sessions.releaseIdle).toHaveBeenCalledExactlyOnceWith("u1", "child-1");
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "releases it when the run ended %s too",
    async (status) => {
      const b = bed();
      const call = b.service.run({ task: "t" }, b.ctx());
      await settle();
      b.finish("child-1", status);
      await b.codeOf(call);
      expect(b.sessions.releaseIdle).toHaveBeenCalledWith("u1", "child-1");
    },
  );

  it("releases it when the parent's call is cancelled, and when the prompt was refused", async () => {
    const stopped = bed();
    const controller = new AbortController();
    const call = stopped.service.run({ task: "t" }, stopped.ctx({ signal: controller.signal }));
    await settle();
    controller.abort();
    await stopped.codeOf(call);
    expect(stopped.sessions.releaseIdle).toHaveBeenCalledWith("u1", "child-1");
    const refused = bed({ promptError: new Error("no") });
    await refused.codeOf(refused.service.run({ task: "t" }, refused.ctx()));
    expect(refused.sessions.releaseIdle).toHaveBeenCalledWith("u1", "child-1");
  });

  it("tries again every two seconds while the worker is busy, and gives up after five tries", async () => {
    const b = bed({ busyReleases: 99 });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("child-1");
    await call;
    expect(b.sessions.releaseIdle).toHaveBeenCalledTimes(1);
    await b.clock.advance(2_000);
    expect(b.sessions.releaseIdle).toHaveBeenCalledTimes(2);
    await b.clock.advance(60_000);
    expect(b.sessions.releaseIdle).toHaveBeenCalledTimes(5);
  });

  it("stops trying once the worker went", async () => {
    const b = bed({ busyReleases: 1 });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("child-1");
    await call;
    await b.clock.advance(2_000);
    await b.clock.advance(60_000);
    expect(b.sessions.releaseIdle).toHaveBeenCalledTimes(2);
  });
});

describe("stopping the service (review minor 3)", () => {
  it("clears the retry timers and tries no more", async () => {
    const b = bed({ busyReleases: 99 });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("child-1");
    await call;
    expect(b.clock.pending()).toBe(1);
    b.service.stop();
    expect(b.clock.pending()).toBe(0);
    await b.clock.advance(60_000);
    expect(b.sessions.releaseIdle).toHaveBeenCalledTimes(1);
  });

  it("does not start a retry after it stopped", async () => {
    const b = bed({ busyReleases: 99 });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.service.stop();
    b.finish("child-1");
    await call;
    expect(b.clock.pending()).toBe(0);
  });
});

describe("a child whose session is gone (review I4)", () => {
  it("returns the answer as tainted: an unknown taint is a tainted one", async () => {
    const b = bed({ childGone: true });
    const call = b.service.run({ task: "t" }, b.ctx({ tainted: false }));
    await settle();
    b.finish("child-1");
    expect(await call).toMatchObject({ tainted: true });
  });
});

describe("how a call ended is recorded (review minors)", () => {
  it("records a deadline as timeout and a parent's cancel as stopped", async () => {
    for (const [reason, recorded] of [
      ["timeout", "timeout"],
      ["cancelled", "stopped"],
      [undefined, "stopped"],
    ] as const) {
      const b = bed();
      const controller = new AbortController();
      const call = b.service.run({ task: "t" }, b.ctx({ signal: controller.signal }));
      await settle();
      controller.abort(reason);
      await b.codeOf(call);
      expect(b.store.get("id-1")).toMatchObject({ state: "cancelled", reason: recorded });
    }
  });

  it("does not prompt a child when the call was cancelled while it started, and clears the expected origin", async () => {
    const b = bed();
    const controller = new AbortController();
    b.sessions.createChild.mockImplementationOnce(async () => {
      controller.abort("cancelled");
      return { sessionId: "child-1", tainted: false };
    });
    expect(await b.codeOf(b.service.run({ task: "t" }, b.ctx({ signal: controller.signal })))).toBe(
      "cancelled",
    );
    expect(b.sessions.prompt).not.toHaveBeenCalled();
    expect(b.calls).toContainEqual(["clearExpected", "child-1"]);
    expect(b.store.get("id-1")).toMatchObject({ state: "cancelled", reason: "stopped" });
  });

  it("clears the expected origin when a running child is cancelled", async () => {
    const b = bed();
    const controller = new AbortController();
    const call = b.service.run({ task: "t" }, b.ctx({ signal: controller.signal }));
    await settle();
    controller.abort();
    await b.codeOf(call);
    expect(b.calls).toContainEqual(["clearExpected", "child-1"]);
  });

  it("titles a row from the task without invisible characters", async () => {
    const b = bed();
    const call = b.service.run({ task: "\u200bFind\u2028 the\u202e bug\u2029" }, b.ctx());
    await settle();
    b.finish("child-1");
    await call;
    expect(b.store.get("id-1")?.title).toBe("Find the bug");
  });
});
