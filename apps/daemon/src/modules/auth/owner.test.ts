import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore } from "./store.ts";
import { type AuthTestBed, createAuthTestBed } from "./testing/fixture.ts";

let bed: AuthTestBed;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => bed.dispose());

describe("the instance owner", () => {
  it("is nobody before setup and the first user after it", () => {
    const { auth } = bed.start("https://pap.example");
    expect(auth.ownerId()).toBeNull();
    createAuthStore(bed.db).insertFirstUser({
      id: "owner-1",
      username: "owner",
      passwordHash: "x",
      createdAt: 1,
    });
    expect(auth.ownerId()).toBe("owner-1");
  });
});
