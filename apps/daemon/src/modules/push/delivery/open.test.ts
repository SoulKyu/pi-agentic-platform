import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../../testing/caller.ts";
import { OWNER, openSendBed, type SendBed } from "../testing/send-bed.ts";
import { createOpenPush } from "./open.ts";

let t: SendBed;
let count = 0;
afterEach(() => t.close());

function open() {
  t = openSendBed(["a"]);
  const service = createOpenPush({ db: t.bed.db });
  const push = (refKind: string, refId: string, cls = "failed", ownerId = OWNER) => {
    const id = `e${String(++count).padStart(21, "0")}`;
    t.bed.db.run(
      `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at)
       VALUES ($id, $owner, $cls, $kind, $ref, $key, 'sent', 1)`,
      { id, owner: ownerId, cls, kind: refKind, ref: refId, key: `k:${id}` },
    );
    return id;
  };
  return { service, push, as: (userId = OWNER) => testCaller({ userId }) };
}

describe("push.open resolves the event the caller owns to a target (M12R33)", () => {
  it.each([
    [
      "an approval of a session opens that session's card",
      "session",
      "s1",
      "approval",
      { kind: "session", id: "s1" },
    ],
    ["an Inbox request", "inbox", "item-1", "approval", { kind: "inbox", id: "item-1" }],
    ["an Inbox failure", "inbox", "item-2", "failed", { kind: "inbox", id: "item-2" }],
    ["the owner-wide budget", "budget", "owner:2026-10-17", "budget", { kind: "settings", id: "automation" }],
    [
      "an agent budget",
      "budget",
      "agent:atlas-1a2b:2026-10-17",
      "budget",
      { kind: "agent", id: "atlas-1a2b" },
    ],
    ["the digest", "digest", "d1", "digest", { kind: "inbox", id: null }],
    ["a test push", "test", "t1", "test", { kind: "settings", id: "notifications" }],
  ] as const)("%s", async (_name, refKind, refId, cls, target) => {
    const { service, push, as } = open();
    expect(await service(as(), push(refKind, refId, cls))).toEqual({ target });
  });

  it("a settled event still resolves: the landing page says it was handled", async () => {
    const { service, push, as } = open();
    const id = push("session", "s1", "approval");
    t.bed.db.run("UPDATE push_events SET state = 'cancelled', reason = 'answered'");
    expect(await service(as(), id)).toEqual({ target: { kind: "session", id: "s1" } });
  });

  it("an unknown id and another owner's id answer the same not_found (no oracle)", async () => {
    const { service, push, as } = open();
    const theirs = push("session", "s1", "approval", "u2");
    const refused = (id: string) => service(as(), id).catch((error: unknown) => error);
    const [other, unknown] = [await refused(theirs), await refused("z".repeat(22))];
    expect(other).toBeInstanceOf(PapError);
    expect(other).toMatchObject({ code: "not_found" });
    expect(unknown).toMatchObject({ code: "not_found" });
    expect((other as Error).message).toBe((unknown as Error).message);
    // The owner of the event is still served.
    expect(await service(as("u2"), theirs)).toEqual({ target: { kind: "session", id: "s1" } });
  });

  it("a ref kind a newer daemon wrote is not_found, not a guess", async () => {
    const { service, push, as } = open();
    await expect(service(as(), push("future", "x"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("a budget id of an unexpected shape lands on the automation settings", async () => {
    const { service, push, as } = open();
    expect(await service(as(), push("budget", "agent:", "budget"))).toEqual({
      target: { kind: "settings", id: "automation" },
    });
  });

  it("a token is forbidden before anything is read", async () => {
    const { service, push } = open();
    const id = push("session", "s1", "approval");
    await expect(service(testCaller({ kind: "token", credentialId: "tok" }), id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
