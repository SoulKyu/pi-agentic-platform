import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { BoundaryError, type BoundaryReason } from "../../kernel/fs/safe-open.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { refusal } from "./access.ts";

const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe("refusal: what the fs layer throws becomes the contract's error (carry 7)", () => {
  it.each(["not_regular", "moved", "denied", "too_large", "exists"] as const satisfies BoundaryReason[])(
    "BoundaryError %s is not_found, so existence never leaks",
    (reason) => {
      const mapped = refusal(new BoundaryError(reason), silentLogger);
      expect(mapped).toBeInstanceOf(PapError);
      expect(mapped).toMatchObject({ code: "not_found" });
    },
  );

  it.each(["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "EISDIR", "ENXIO", "ENAMETOOLONG", "ENODEV"])(
    "errno %s is not_found",
    (code) => {
      expect(refusal(errno(code), silentLogger)).toMatchObject({ code: "not_found" });
    },
  );

  it("keeps a PapError, and leaves anything else to the dispatcher (internal, logged)", () => {
    const busy = new PapError("capacity");
    expect(refusal(busy, silentLogger)).toBe(busy);
    const odd = errno("EMFILE");
    expect(refusal(odd, silentLogger)).toBe(odd);
    const plain = new Error("boom");
    expect(refusal(plain, silentLogger)).toBe(plain);
  });
});
