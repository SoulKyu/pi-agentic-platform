import { describe, expect, it } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { saveNotifications } from "./save-notifications.ts";

const DEFAULTS = {
  classes: {
    approval: true,
    failed: true,
    budget: true,
    notify: true,
    done: false,
    reply: false,
  },
  muteUntil: null,
  titles: "generic",
};

function server(initial: unknown, revision = 3) {
  const calls: Array<[string, unknown]> = [];
  const state = { value: initial, revision, failSets: [] as string[] };
  const rpc = {
    newCommandId: () => "cmd",
    call: async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === "settings.get") return { value: state.value, revision: state.revision };
      const failure = state.failSets.shift();
      if (failure) throw new RpcError(failure as "conflict");
      const body = params as { value: unknown; baseRevision: number };
      if (body.baseRevision !== state.revision) throw new RpcError("conflict");
      state.value = body.value;
      state.revision += 1;
      return { revision: state.revision };
    },
  };
  return { rpc: rpc as never, calls, state };
}

describe("saveNotifications", () => {
  it("reads, changes and sends the whole document with the revision read", async () => {
    const bed = server(null);
    const saved = await saveNotifications(bed.rpc, (doc) => ({ ...doc, titles: "names" }));
    expect(saved).toEqual({ ...DEFAULTS, titles: "names" });
    expect(bed.calls[1]).toEqual([
      "settings.set",
      { key: "notifications", value: { ...DEFAULTS, titles: "names" }, baseRevision: 3 },
    ]);
  });

  it("on conflict reads again and re-applies the change over the newer copy, once", async () => {
    const bed = server(DEFAULTS);
    bed.state.failSets = ["conflict"];
    // Another device wrote between the failed set and the re-read.
    const saved = await saveNotifications(bed.rpc, (doc) => {
      bed.state.value = { ...DEFAULTS, muteUntil: 77 };
      return { ...doc, classes: { ...doc.classes, done: true } };
    });
    expect(saved.muteUntil).toBe(77);
    expect(saved.classes.done).toBe(true);
    expect(bed.calls.map(([method]) => method)).toEqual([
      "settings.get",
      "settings.set",
      "settings.get",
      "settings.set",
    ]);
  });

  it("a second conflict is the caller's to show", async () => {
    const bed = server(DEFAULTS);
    bed.state.failSets = ["conflict", "conflict"];
    await expect(saveNotifications(bed.rpc, (doc) => doc)).rejects.toMatchObject({ code: "conflict" });
  });

  it("never overwrites a stored document this build cannot read", async () => {
    const bed = server({ classes: "nope" });
    await expect(saveNotifications(bed.rpc, (doc) => doc)).rejects.toMatchObject({ code: "bad_request" });
    expect(bed.calls.map(([method]) => method)).toEqual(["settings.get"]);
  });
});
