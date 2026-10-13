import { MAX_PASSKEYS_LISTED } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createPasskeyBed, OWNER_ID } from "./testing/passkey-bed.ts";

let current: ReturnType<typeof createPasskeyBed> | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

describe("passkey listings", () => {
  it("come newest first, so a rogue passkey is never hidden past the limit", () => {
    const bed = (current = createPasskeyBed());
    const total = MAX_PASSKEYS_LISTED + 5;
    for (let i = 0; i < total; i++) {
      bed.store.insertPasskey({
        id: `bulk-${String(i).padStart(3, "0")}`,
        userId: OWNER_ID,
        publicKey: new Uint8Array([1]),
        counter: 0,
        transports: [],
        createdAt: 10_000 + i,
      });
    }
    const listed = bed.store.listPasskeyListings(OWNER_ID, MAX_PASSKEYS_LISTED);
    expect(listed).toHaveLength(MAX_PASSKEYS_LISTED);
    expect(listed[0]?.id).toBe(`bulk-${String(total - 1).padStart(3, "0")}`);
    expect(listed.at(-1)?.id).toBe("bulk-005");
    expect(listed.map((row) => row.createdAt)).toEqual(
      [...listed.map((row) => row.createdAt)].sort((a, b) => b - a),
    );
  });

  it("break a tie on creation time by the later insert", () => {
    const bed = (current = createPasskeyBed());
    for (const id of ["tie-b", "tie-a"]) {
      bed.store.insertPasskey({
        id,
        userId: OWNER_ID,
        publicKey: new Uint8Array([1]),
        counter: 0,
        transports: [],
        createdAt: 50_000,
      });
    }
    expect(bed.store.listPasskeyListings(OWNER_ID, 2).map((row) => row.id)).toEqual(["tie-a", "tie-b"]);
  });
});
