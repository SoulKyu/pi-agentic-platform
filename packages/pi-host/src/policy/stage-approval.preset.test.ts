import { PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantKey, grantPayload } from "./grant-key.ts";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { withPreset } from "../tool-presets.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const rulesIn = (approvalMode: PolicyRules["approvalMode"], preset: "read-only" | "configured") =>
  withPreset(PolicyRules.parse({ profile: "interactive", approvalMode }), preset) as PolicyRules;
const tools = {
  read: { path: "/ext/read.js" },
  ext_write: { path: "/ext/write.js", readOnlyHint: false },
};

describe("under the read-only preset a call that is not a read is never unasked (MC36)", () => {
  it("asks for an extension that took the name `read`, even in full-access", async () => {
    const h = bed.harness({ rules: () => rulesIn("full-access", "read-only"), tools });
    expect(await h.run("read", { path: "a" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ category: "unknown", answers: ["deny", "once"] });
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved" });
  });

  it("asks for an extension write tool, and Deny stops it", async () => {
    const h = bed.harness({
      rules: () => rulesIn("full-access", "read-only"),
      tools,
      answers: [{ answer: "deny", closed: false }],
    });
    expect(await h.run("ext_write", { path: "a" })).toMatchObject({ block: true });
    expect(h.asks).toHaveLength(1);
  });

  it("asks again every time: no grant skips it", async () => {
    const h = bed.harness({ rules: () => rulesIn("full-access", "read-only"), tools });
    await h.run("ext_write", { path: "a" }, "c1");
    await h.run("ext_write", { path: "a" }, "c2");
    expect(h.asks).toHaveLength(2);
  });

  it("lets Pi's built-in read run unasked", async () => {
    const h = bed.harness({ rules: () => rulesIn("full-access", "read-only") });
    expect(await h.run("read", { path: "src/a.ts" })).toBeUndefined();
    expect(h.asks).toHaveLength(0);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow" });
  });

  it("blocks where nobody can be asked", async () => {
    const h = bed.harness({ rules: () => rulesIn("full-access", "read-only"), tools, hasUI: false });
    expect(await h.run("ext_write", { path: "a" })).toMatchObject({ block: true });
    expect(h.asks).toHaveLength(0);
  });

  it("leaves the same tools unasked in full-access without the preset", async () => {
    const h = bed.harness({ rules: () => rulesIn("full-access", "configured"), tools });
    expect(await h.run("ext_write", { path: "a" })).toBeUndefined();
    expect(await h.run("read", { path: "a" })).toBeUndefined();
    expect(h.asks).toHaveLength(0);
  });

  it("keeps the read-only approval mode blocking unknown tools", async () => {
    const h = bed.harness({ rules: () => rulesIn("read-only", "read-only"), tools });
    expect(await h.run("ext_write", { path: "a" })).toMatchObject({ block: true });
    expect(h.asks).toHaveLength(0);
  });
});

describe.each(["full-access", "supervised", "auto-accept-edits"] as const)(
  "grants never skip the preset's question: %s",
  (mode) => {
    it("offers only Deny and Allow once", async () => {
      const h = bed.harness({ rules: () => rulesIn(mode, "read-only"), tools });
      await h.run("ext_write", { path: "a" });
      expect(h.asks).toHaveLength(1);
      expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
    });

    it("asks again after a session grant made before the switch to read-only", async () => {
      let rules = rulesIn("supervised", "configured");
      const h = bed.harness({
        rules: () => rules,
        tools,
        answers: [{ answer: "session", closed: false }],
      });
      await h.run("ext_write", { path: "a" }, "c1");
      expect(h.asks).toHaveLength(1);
      expect(h.asks[0]?.answers).toContain("session");
      // The grant works while the preset is off ...
      await h.run("ext_write", { path: "a" }, "c2");
      expect(h.asks).toHaveLength(1);
      // ... and is ignored once it is on.
      rules = rulesIn(mode, "read-only");
      await h.run("ext_write", { path: "a" }, "c3");
      expect(h.asks).toHaveLength(2);
      expect(h.asks[1]?.answers).toEqual(["deny", "once"]);
    });

    it("asks although an exact always rule matches", async () => {
      const input = { path: "a" };
      const always = [{ tool: "ext_write", key: grantKey("ext_write", grantPayload(input, false)) }];
      const rules = PolicyRules.parse({
        ...rulesIn(mode, "read-only"),
        alwaysAllow: always,
      });
      const h = bed.harness({ rules: () => rules, tools });
      expect(await h.run("ext_write", input)).toBeUndefined();
      expect(h.asks).toHaveLength(1);
      expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
      // Control: without the preset the rule lets it through in an asking mode.
      const control = bed.harness({
        rules: () => PolicyRules.parse({ ...rules, readOnlyPreset: false, presetTools: null }),
        tools,
      });
      await control.run("ext_write", input);
      expect(control.asks).toHaveLength(0);
    });
  },
);
