import { PapError, TEMPLATE_AUDIT_REASON, type TemplatesSaveParams } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createPiWriteQueue } from "../../kernel/pi-write-queue.ts";
import { testCaller } from "../../testing/caller.ts";
import { fakePool, type RunCall } from "../models/testing/bed.ts";
import { createTemplates } from "./templates.ts";

const params: TemplatesSaveParams = { name: "review", description: "Secret desc", body: "Secret body $1\n" };
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

function bed(answer: (call: RunCall) => unknown = () => ({ replaced: false })) {
  const { pool, calls } = fakePool(answer);
  const rows: unknown[] = [];
  const templates = createTemplates({
    run: async (op, body, deadlineMs) => (await pool.run(op, body, { deadlineMs }).done) as never,
    writes: createPiWriteQueue(),
    clock: createFakeClock(),
    audit: { append: (row) => void rows.push(row) },
  });
  return { templates, calls, rows };
}
const stepped = testCaller({ stepUpUntil: Number.MAX_SAFE_INTEGER });

describe("templates.save", () => {
  it("without the step-up it answers step_up_required and no helper runs", async () => {
    const { templates, calls, rows } = bed();
    expect(await codeOf(templates.save(testCaller(), params))).toBe("step_up_required");
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("a write appends exactly one audit row, reason prompt_template_saved with detail { name }, and no body text anywhere in it", async () => {
    const { templates, calls, rows } = bed();
    expect(await templates.save(stepped, params)).toEqual({ name: "review", replaced: false });
    expect(calls[0]).toMatchObject({ op: "templates.write" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: stepped.userId,
      actor: "user",
      kind: "auth",
      reason: TEMPLATE_AUDIT_REASON,
      detail: { name: "review" },
    });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain("Secret body");
    expect(text).not.toContain("Secret desc");
  });

  it("conflict maps to conflict with no audit row", async () => {
    const { templates, rows } = bed(() => new PapError("conflict"));
    expect(await codeOf(templates.save(stepped, params))).toBe("conflict");
    expect(rows).toEqual([]);
  });

  it("replace: true is passed on and replaced comes back", async () => {
    const { templates, calls } = bed(() => ({ replaced: true }));
    expect(await templates.save(stepped, { ...params, replace: true })).toEqual({
      name: "review",
      replaced: true,
    });
    expect(calls[0]?.params).toMatchObject({ replace: true });
  });
});
