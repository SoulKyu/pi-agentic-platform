import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore } from "./store.ts";
import { type AuthTestBed, createAuthTestBed } from "./testing/fixture.ts";
import { insertUserRow } from "./testing/users.ts";

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

  it("is the user whose role is owner, whatever the creation order", () => {
    const { auth } = bed.start("https://pap.example");
    insertUserRow(bed.db, { id: "u-b", createdAt: 5 });
    insertUserRow(bed.db, { id: "u-old", createdAt: 2 });
    expect(auth.ownerId()).toBeNull();
    insertUserRow(bed.db, { id: "u-new", createdAt: 9, role: "owner" });
    expect(auth.ownerId()).toBe("u-new");
  });
});
