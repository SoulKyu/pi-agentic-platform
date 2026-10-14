import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { modelsBed } from "./testing/bed.ts";

const revision = "a".repeat(64);
const saved = { revision: "b".repeat(64), enabledModelsSynced: true };
const refusal = { code: "config_invalid", issues: ["$.providers"] };
const params = { text: '{"providers":{}}', baseRevision: revision };
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

describe("models service: models.json editor", () => {
  it("gives the helper a boot key for the revision: 32 random bytes, the same for every call of one service, another after a restart", async () => {
    const keyOf = (call: { params: unknown }) => (call.params as { revisionKey: string }).revisionKey;
    const view = { text: null, issues: [], revision, path: "/a/models.json" };
    const first = modelsBed((call) => (call.op === "models.config.get" ? view : saved));
    await first.service.configGet();
    await first.service.configGet();
    await first.service.configSave(testCaller({ stepUpUntil: first.clock.now() + 60_000 }), params);
    const keys = first.calls.map(keyOf);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(keys).size).toBe(1);
    expect(first.calls[2]?.params).toEqual({ ...params, revisionKey: keys[0] });
    const second = modelsBed(() => view);
    await second.service.configGet();
    expect(keyOf(second.calls[0] as { params: unknown })).not.toBe(keys[0]);
  });

  it("reads through the helper with no cwd and parses the result strictly", async () => {
    const view = { text: "{}", issues: [], revision, path: "/a/models.json" };
    const { service, calls } = modelsBed(() => view);
    expect(await service.configGet()).toEqual(view);
    expect(calls[0]).toMatchObject({ op: "models.config.get" });
    const leaky = modelsBed(() => ({ ...view, secrets: ["sk-LEAK"] }));
    expect(await codeOf(leaky.service.configGet())).toBe("helper_failed");
    expect(JSON.stringify(leaky.lines)).not.toContain("sk-LEAK");
  });

  it("asks for the password step-up before any helper starts, and a token never passes", async () => {
    const { service, calls, clock } = modelsBed(() => saved);
    expect(await codeOf(service.configSave(testCaller(), params))).toBe("step_up_required");
    expect(await codeOf(service.configSave(testCaller({ stepUpUntil: clock.now() }), params))).toBe(
      "step_up_required",
    );
    expect(
      await codeOf(
        service.configSave(testCaller({ kind: "token", stepUpUntil: clock.now() + 60_000 }), params),
      ),
    ).toBe("step_up_required");
    expect(calls).toHaveLength(0);
  });

  it("saves with a write deadline, audits a saved file with no value, and returns the revision", async () => {
    const { service, calls, clock, audit } = modelsBed(() => saved);
    const caller = testCaller({ stepUpUntil: clock.now() + 60_000 });
    expect(await service.configSave(caller, params)).toEqual(saved);
    expect(calls[0]).toMatchObject({ op: "models.config.save", params: expect.objectContaining(params) });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: "auth", reason: "models_config_saved", detail: {} });
    expect(JSON.stringify(audit)).not.toContain(params.text);
  });

  it("returns a content refusal as a result, not audited", async () => {
    const { service, clock, audit } = modelsBed(() => refusal);
    const caller = testCaller({ stepUpUntil: clock.now() + 60_000 });
    expect(await service.configSave(caller, params)).toEqual(refusal);
    expect(audit).toHaveLength(0);
  });

  it("passes the helper's typed errors on and audits nothing", async () => {
    for (const code of ["conflict", "config_path_refused", "config_hard_link", "config_invalid"] as const) {
      const { service, clock, audit } = modelsBed(() => new PapError(code));
      const caller = testCaller({ stepUpUntil: clock.now() + 60_000 });
      expect(await codeOf(service.configSave(caller, params))).toBe(code);
      expect(audit).toHaveLength(0);
    }
  });

  it("refuses a result that carries more than a revision", async () => {
    const { service, clock } = modelsBed(() => ({ ...saved, text: "sk-LEAK" }));
    const caller = testCaller({ stepUpUntil: clock.now() + 60_000 });
    expect(await codeOf(service.configSave(caller, params))).toBe("helper_failed");
  });

  it("logs the helper's two fixed events by kind and code, and nothing else of them", async () => {
    const { service, clock, lines } = modelsBed((call) => {
      call.options.onEvent?.({ kind: "folder_sync_failed", code: "EIO", detail: "/home/x/sk-LEAK" });
      call.options.onEvent?.({ kind: "enabled_models_not_synced", code: "sk-LEAK/not a code" });
      call.options.onEvent?.({ kind: "validation_copy_not_removed", code: "failed" });
      call.options.onEvent?.({ kind: "something else", code: "EIO" });
      call.options.onEvent?.(null);
      return saved;
    });
    await service.configSave(testCaller({ stepUpUntil: clock.now() + 60_000 }), params);
    const logged = lines.filter((line) => line.msg === "models_config_save_event");
    expect(logged.map((line) => [line.kind, line.code])).toEqual([
      ["folder_sync_failed", "EIO"],
      ["enabled_models_not_synced", "unknown"],
      ["validation_copy_not_removed", "failed"],
    ]);
    expect(JSON.stringify(lines)).not.toContain("sk-LEAK");
  });
});
