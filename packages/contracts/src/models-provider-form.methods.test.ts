import { describe, expect, it } from "vitest";
import { METHOD_IDEMPOTENT } from "./methods-idempotent.ts";
import { methods } from "./index.ts";

const get = methods["models.provider.get"];
const save = methods["models.provider.save"];
const remove = methods["models.provider.remove"];

describe("the provider form methods", () => {
  it("are pi:admin: a token holds no pi:admin permission, so every one is forbidden to a token", () => {
    for (const def of [get, save, remove]) expect(def.permission).toBe("pi:admin");
  });

  it("get is idempotent and asks for no step-up; save and remove are not idempotent and ask for it", () => {
    expect(get.idempotent).toBe(true);
    expect(save.idempotent).toBe(false);
    expect(remove.idempotent).toBe(false);
    expect(get.errors).not.toContain("step_up_required");
    expect(save.errors).toContain("step_up_required");
    expect(remove.errors).toContain("step_up_required");
  });

  it("keeps METHOD_IDEMPOTENT equal to the declarations (the web client reads only the table)", () => {
    expect(METHOD_IDEMPOTENT["models.provider.get"]).toBe(true);
    expect(METHOD_IDEMPOTENT["models.provider.save"]).toBe(false);
    expect(METHOD_IDEMPOTENT["models.provider.remove"]).toBe(false);
  });

  it("bind the target in the receipt selector, and mark no body field", () => {
    expect(save.sensitiveParams).toEqual(["id", "mode", "baseRevision"]);
    expect(remove.sensitiveParams).toEqual(["id", "baseRevision", "alsoRemoveKey"]);
    expect("sensitiveParams" in get).toBe(false);
  });

  it("answer a refusal of the content as a result, and the write errors as codes", () => {
    for (const def of [save, remove])
      expect(def.errors).toEqual(
        expect.arrayContaining(["conflict", "not_found", "capacity", "timeout", "helper_failed"]),
      );
    expect(save.errors).toEqual(expect.arrayContaining(["config_path_refused", "config_hard_link"]));
    expect(save.result.safeParse({ code: "config_invalid", issues: ["$.provider.id"] }).success).toBe(true);
  });
});
