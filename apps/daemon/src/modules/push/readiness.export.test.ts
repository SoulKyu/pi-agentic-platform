import { describe, expect, it } from "vitest";
import { pushReadiness as kernelReadiness } from "../../kernel/push-readiness.ts";
import { pushReadiness } from "./index.ts";

describe("the push barrel", () => {
  it("re-exports the kernel's pushReadiness, one HTTPS truth (M12R38)", () => {
    expect(pushReadiness).toBe(kernelReadiness);
  });
});
