import { type Caller, PapError, type ProviderSaveParams } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { testCaller } from "../../testing/caller.ts";
import { auditId, createProviderConfig } from "./provider-config.ts";

const REV = "a".repeat(64);
const NEXT = "b".repeat(64);
const saved = { revision: NEXT, enabledModelsSynced: true };
const provider = {
  id: "mine",
  api: "openai-completions" as const,
  baseUrl: "https://example.test/v1",
  auth: { kind: "stored" as const },
  headers: [],
  models: [{ id: "m1" }],
};
const save: ProviderSaveParams = { mode: "create", id: "mine", provider, baseRevision: REV };
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

function bed(answer: (op: string, params: unknown) => unknown = () => saved) {
  const clock = createFakeClock();
  const ran: Array<{ op: string; params: unknown; deadlineMs: number }> = [];
  const audit: Array<{ reason: string; detail: Record<string, string> }> = [];
  const state = { invalidated: 0, slots: 0 };
  const config = createProviderConfig({
    run: (async (op: string, params: unknown, deadlineMs: number) => {
      ran.push({ op, params, deadlineMs });
      const outcome = answer(op, params);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }) as never,
    serialised: (task) => {
      state.slots++;
      return task();
    },
    revisionKey: "k".repeat(64),
    clock,
    audit: (_caller, reason, detail) => void audit.push({ reason, detail }),
    invalidate: () => void state.invalidated++,
    logSaveEvent: () => {},
  });
  const owner = (): Caller => testCaller({ stepUpUntil: clock.now() + 60_000 });
  return { config, ran, audit, state, owner, clock };
}

describe("provider save", () => {
  it("save.step-up-first: no helper runs, no queue slot is taken, nothing is audited", async () => {
    const { config, ran, audit, state, clock } = bed();
    expect(await codeOf(config.save(testCaller(), save))).toBe("step_up_required");
    expect(await codeOf(config.save(testCaller({ stepUpUntil: clock.now() }), save))).toBe(
      "step_up_required",
    );
    expect(
      await codeOf(config.save(testCaller({ kind: "token", stepUpUntil: clock.now() + 60_000 }), save)),
    ).toBe("step_up_required");
    expect(ran).toEqual([]);
    expect(state).toEqual({ invalidated: 0, slots: 0 });
    expect(audit).toEqual([]);
  });

  it("runs one helper op in one queue slot with the boot key, and audits the provider id only", async () => {
    const { config, ran, audit, state, owner } = bed();
    expect(await config.save(owner(), save)).toEqual(saved);
    expect(ran).toEqual([
      { op: "models.provider.save", params: { ...save, revisionKey: "k".repeat(64) }, deadlineMs: 30_000 },
    ]);
    expect(state.slots).toBe(1);
    expect(audit).toEqual([{ reason: "provider_saved", detail: { provider: "mine" } }]);
  });

  it("audits no URL, header, model or revision, whatever the provider holds", async () => {
    const { config, audit, owner } = bed();
    await config.save(owner(), {
      ...save,
      provider: {
        ...provider,
        headers: [{ name: "X-Team", value: { kind: "literal", text: "HEADER-MARKER" } }],
      },
    });
    const text = JSON.stringify(audit);
    for (const word of ["example.test", "HEADER-MARKER", "X-Team", "m1", REV, NEXT])
      expect(text).not.toContain(word);
  });

  it("passes a stale-revision conflict through, without audit", async () => {
    const { config, audit, owner } = bed(() => new PapError("conflict"));
    expect(await codeOf(config.save(owner(), save))).toBe("conflict");
    expect(audit).toEqual([]);
  });

  it("returns a config_invalid result as a result and does not audit it", async () => {
    const invalid = { code: "config_invalid", issues: ["$.provider.id"] };
    const { config, audit, owner } = bed(() => invalid);
    expect(await config.save(owner(), save)).toEqual(invalid);
    expect(audit).toEqual([]);
  });

  it("provider.invalidates-available: after a save, a refused save and a failed save", async () => {
    const ok = bed();
    await ok.config.save(ok.owner(), save);
    expect(ok.state.invalidated).toBe(1);
    const refused = bed(() => ({ code: "config_invalid", issues: ["$"] }));
    await refused.config.save(refused.owner(), save);
    expect(refused.state.invalidated).toBe(1);
    const failed = bed(() => new PapError("helper_failed"));
    await codeOf(failed.config.save(failed.owner(), save));
    expect(failed.state.invalidated).toBe(1);
  });
});

describe("provider get", () => {
  it("needs no step-up, is not audited and does not take a queue slot", async () => {
    const view = { editable: false, reason: "not_in_file", revision: REV };
    const { config, ran, audit, state } = bed(() => view);
    expect(await config.get(testCaller(), { id: "mine" })).toEqual(view);
    expect(await config.get(testCaller(), {})).toEqual(view);
    expect(ran).toEqual([
      { op: "models.provider.get", params: { id: "mine", revisionKey: "k".repeat(64) }, deadlineMs: 30_000 },
      { op: "models.provider.get", params: { revisionKey: "k".repeat(64) }, deadlineMs: 30_000 },
    ]);
    expect(audit).toEqual([]);
    expect(state).toEqual({ invalidated: 0, slots: 0 });
  });
});

describe("provider remove", () => {
  const remove = { id: "mine", baseRevision: REV, alsoRemoveKey: false };

  it("asks for the step-up before any helper runs", async () => {
    const { config, ran, state } = bed();
    expect(await codeOf(config.remove(testCaller(), remove))).toBe("step_up_required");
    expect(ran).toEqual([]);
    expect(state.slots).toBe(0);
  });

  it("removes the entry only and audits provider_removed with the id", async () => {
    const { config, ran, audit, state, owner } = bed();
    expect(await config.remove(owner(), remove)).toEqual(saved);
    expect(ran.map((call) => call.op)).toEqual(["models.provider.remove"]);
    expect(audit).toEqual([{ reason: "provider_removed", detail: { provider: "mine" } }]);
    expect(state).toEqual({ invalidated: 1, slots: 1 });
  });

  it("alsoRemoveKey: remove then auth.logout in ONE queue slot, both audited", async () => {
    const { config, ran, audit, state, owner } = bed();
    await config.remove(owner(), { ...remove, alsoRemoveKey: true });
    expect(ran.map((call) => call.op)).toEqual(["models.provider.remove", "auth.logout"]);
    expect(ran[1]?.params).toEqual({ provider: "mine" });
    expect(state.slots).toBe(1);
    expect(audit).toEqual([
      { reason: "provider_removed", detail: { provider: "mine" } },
      { reason: "provider_signed_out", detail: { provider: "mine" } },
    ]);
  });

  it("alsoRemoveKey keeps the key when the removal is refused or conflicts", async () => {
    const refused = bed(() => ({ code: "config_invalid", issues: ["$.file"] }));
    await refused.config.remove(refused.owner(), { ...remove, alsoRemoveKey: true });
    expect(refused.ran.map((call) => call.op)).toEqual(["models.provider.remove"]);
    expect(refused.audit).toEqual([]);
    const stale = bed(() => new PapError("conflict"));
    await codeOf(stale.config.remove(stale.owner(), { ...remove, alsoRemoveKey: true }));
    expect(stale.ran.map((call) => call.op)).toEqual(["models.provider.remove"]);
  });

  it("alsoRemoveKey with no stored key: a not_found sign-out is 'no key', the removal stands, no sign-out audit", async () => {
    const { config, audit, owner } = bed((op) => (op === "auth.logout" ? new PapError("not_found") : saved));
    expect(await config.remove(owner(), { ...remove, alsoRemoveKey: true })).toEqual(saved);
    expect(audit).toEqual([{ reason: "provider_removed", detail: { provider: "mine" } }]);
  });

  it("a sign-out that fails after the removal still audits the removal, and the error reaches the caller", async () => {
    const { config, audit, state, owner } = bed((op) =>
      op === "auth.logout" ? new PapError("helper_failed") : saved,
    );
    expect(await codeOf(config.remove(owner(), { ...remove, alsoRemoveKey: true }))).toBe("helper_failed");
    expect(audit).toEqual([{ reason: "provider_removed", detail: { provider: "mine" } }]);
    expect(state.invalidated).toBe(1);
  });

  it("remove.any-id: a provider the form cannot edit is removed by a browser caller", async () => {
    const { config, ran, owner } = bed();
    await config.remove(owner(), { ...remove, id: "Weird_ID" });
    expect(ran[0]?.params).toMatchObject({ id: "Weird_ID" });
  });

  it("provider.invalidates-available: also when the removal throws", async () => {
    const { config, state, owner } = bed(() => new PapError("timeout"));
    await codeOf(config.remove(owner(), remove));
    expect(state.invalidated).toBe(1);
  });

  it("clips and escapes the id in the audit detail: it is untrusted text", async () => {
    const { config, audit, owner } = bed();
    await config.remove(owner(), { ...remove, id: `A\u202Eb\n${"x".repeat(200)}` });
    const detail = audit[0]?.detail.provider ?? "";
    expect(detail).toBe(`A\\u202eb\\u000a${"x".repeat(50)}...`);
  });
});

describe("auditId", () => {
  it("keeps plain ids whole and escapes backslash, controls, bidi, zero-width and astral characters", () => {
    expect(auditId("mine-2")).toBe("mine-2");
    expect(auditId("a\\b")).toBe("a\\u005cb");
    expect(auditId("a\u200Bb\u2066c")).toBe("a\\u200bb\\u2066c");
    expect(auditId("a\u{1F600}")).toBe("a\\u{1f600}");
    expect(auditId("a".repeat(64))).toBe("a".repeat(64));
    expect(auditId("a".repeat(65))).toBe(`${"a".repeat(64)}...`);
  });
});
