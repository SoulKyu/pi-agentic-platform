import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ALWAYS_RULES, methods } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { createPolicyService } from "./service.ts";
import { createPolicyStore } from "./store.ts";
import { createPolicyBed, KEY, keyOf } from "./testing/bed.ts";

let bed: ReturnType<typeof makeBed>;
const makeBed = () => {
  const base = createPolicyBed();
  const store = createPolicyStore(base.db);
  const service = createPolicyService({ store, clock: base.clock, logger: base.logger, newId: base.newId });
  return { ...base, store, service };
};
beforeEach(() => {
  bed = makeBed();
});
afterEach(() => bed.dispose());

// Near the worst a 4096-character label can weigh in JSON: quotes, backslashes and control characters take two to six bytes each. (NUL is left out: SQLite text stops at it.)
const WORST = ['"', "\\", String.fromCharCode(1), String.fromCharCode(31), "\u00e9"]
  .join("")
  .repeat(1024)
  .slice(0, 4096);
const rule = { ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: WORST };

describe("policy list page", () => {
  it("fits the response under the page budget, newest rules first, and says it left some out", async () => {
    const { service, clock } = bed;
    for (let i = 1; i <= MAX_ALWAYS_RULES; i++) {
      await clock.advance(1);
      service.addAlways({ ...rule, key: keyOf(i) });
    }
    expect(sizeOf({ rules: service.list("u1"), truncated: false })).toBeGreaterThan(4 * PAGE_BYTES);
    const page = service.listPage("u1");
    expect(page.truncated).toBe(true);
    expect(sizeOf(page)).toBeLessThanOrEqual(PAGE_BYTES);
    expect(methods["policy.listRules"].result.safeParse(page).success).toBe(true);
    // Exactly the newest ones: one more would not have fitted.
    const all = service.list("u1");
    expect(page.rules).toEqual(all.slice(0, page.rules.length));
    expect(page.rules[0]?.id).toBe(`r${MAX_ALWAYS_RULES}`);
    expect(sizeOf({ rules: all.slice(0, page.rules.length + 1), truncated: true })).toBeGreaterThan(
      PAGE_BYTES,
    );
    expect(page.rules.length).toBeGreaterThan(0);
    expect(page.rules.length).toBeLessThan(MAX_ALWAYS_RULES);
  });

  it("is not truncated when everything fits", () => {
    bed.service.addAlways({ ...rule, label: "small" });
    const page = bed.service.listPage("u1");
    expect(page).toEqual({ rules: bed.service.list("u1"), truncated: false });
    expect(bed.service.listPage("u2")).toEqual({ rules: [], truncated: false });
  });

  it("lists the project of a folder: the git root of a folder inside a repository", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pap-policy-list-")));
    try {
      mkdirSync(join(root, "repo", ".git"), { recursive: true });
      mkdirSync(join(root, "repo", "sub"));
      mkdirSync(join(root, "other"));
      bed.service.addAlways({ ...rule, scope: join(root, "repo"), label: "in repo" });
      bed.service.addAlways({ ...rule, scope: join(root, "other"), label: "in other" });
      expect(bed.service.listPage("u1", join(root, "repo", "sub")).rules.map((r) => r.label)).toEqual([
        "in repo",
      ]);
      expect(bed.service.listPage("u1", join(root, "other")).rules.map((r) => r.label)).toEqual(["in other"]);
      expect(bed.service.listPage("u1").rules).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
