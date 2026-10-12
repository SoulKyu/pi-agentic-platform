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

  it("is the oldest user, a tie in created_at broken by id", () => {
    const { auth } = bed.start("https://pap.example");
    const add = (id: string, createdAt: number) =>
      bed.db.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ($id, $id, 'x', $createdAt)",
        {
          id,
          createdAt,
        },
      );
    add("u-b", 5);
    add("u-new", 9);
    expect(auth.ownerId()).toBe("u-b");
    add("u-old", 2);
    expect(auth.ownerId()).toBe("u-old");
    add("u-a", 2);
    expect(auth.ownerId()).toBe("u-a");
  });
});
