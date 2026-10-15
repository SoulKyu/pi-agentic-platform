import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectScopeOf } from "./project-scope.ts";
import { createPolicyService } from "./service.ts";
import { createPolicyStore } from "./store.ts";
import { createPolicyBed } from "./testing/bed.ts";

let bed: ReturnType<typeof createPolicyBed>;
beforeEach(() => {
  bed = createPolicyBed();
});
afterEach(() => bed.dispose());

const serviceWith = (scopeAlias?: (cwd: string) => string | null) =>
  createPolicyService({
    store: createPolicyStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: bed.newId,
    audit: bed.audit,
    ...(scopeAlias ? { scopeAlias } : {}),
  });

describe("policy scopeOf with a scope alias (M9R35)", () => {
  it("asks the alias first", () => {
    const calls: string[] = [];
    const service = serviceWith((cwd) => {
      calls.push(cwd);
      return cwd.startsWith("/lanes/") ? "/project" : null;
    });
    expect(service.scopeOf("/lanes/a/src")).toBe("/project");
    expect(calls).toEqual(["/lanes/a/src"]);
  });

  it("falls back to the project scope when the alias answers null, and when there is none", () => {
    const cwd = "/tmp/pap-no-such-project";
    expect(serviceWith(() => null).scopeOf(cwd)).toBe(projectScopeOf(cwd));
    expect(serviceWith().scopeOf(cwd)).toBe(projectScopeOf(cwd));
  });
});
