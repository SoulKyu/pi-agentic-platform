import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { OTHER_BOX, PROJECT_BOX, registryBed } from "./testing/registry-bed.ts";

const OWNER = "u1";

function tokenFor(bed: ReturnType<typeof registryBed>, serviceId: string, box = PROJECT_BOX): string {
  return bed.tokens.mintService({ ownerId: OWNER, box, serviceId, port: 3000, sources: [] }).token;
}

describe("a guest that lies about its services", () => {
  const as = (answer: unknown) =>
    answer as { name?: string; id?: string; network?: boolean; services?: unknown[] };

  it("an answer under another name is refused internal and records nothing", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    bed.lie((_op, answer) => ({ ...as(answer), name: "other" }));
    await expect(bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"))).rejects.toEqual(
      new PapError("internal"),
    );
    expect(bed.registry.list(PROJECT_BOX)).toEqual([]);
    expect(
      bed.lines.some(
        (line) => line["msg"] === "preview_guest_answer_refused" && line["why"] === "other_service",
      ),
    ).toBe(true);
  });

  it("an answer on another port is refused", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    bed.lie((_op, answer) => ({ ...as(answer), port: 4000 }));
    await expect(bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site", 3000))).rejects.toEqual(
      new PapError("internal"),
    );
    expect(bed.registry.list(PROJECT_BOX)).toEqual([]);
  });

  it("never more than four records, whatever names the guest answers", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    let n = 0;
    bed.lie((_op, answer) => ({ ...as(answer), name: `n${n++}` }));
    for (let i = 0; i < 8; i++)
      await bed.registry.start(PROJECT_BOX, OWNER, bed.spec(`s${i}`)).catch(() => undefined);
    expect(bed.registry.list(PROJECT_BOX).length).toBeLessThanOrEqual(4);
    expect(bed.registry.list(PROJECT_BOX)).toEqual([]);
  });

  it("network true for a no-network spec: the record stays network false", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    bed.lie((_op, answer) => ({ ...as(answer), network: true }));
    const view = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site", 3000, false));
    expect(view.network).toBe(false);
    expect(bed.registry.list(PROJECT_BOX)[0]?.network).toBe(false);
    expect(bed.registry.byId(view.id)?.view.network).toBe(false);
  });

  it("a restart answer and a list that flip network leave the record false", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site", 3000, false));
    bed.lie((op, answer) =>
      op.name === "svc.list"
        ? { services: (as(answer).services as object[]).map((service) => ({ ...service, network: true })) }
        : { ...as(answer), network: true },
    );
    expect((await bed.registry.restart(PROJECT_BOX, "site")).network).toBe(false);
    await bed.registry.refresh(PROJECT_BOX);
    expect(bed.registry.list(PROJECT_BOX)[0]?.network).toBe(false);
    expect(
      bed.events.every(
        ({ event }) => (event as { service?: { network: boolean } }).service?.network !== true,
      ),
    ).toBe(true);
  });

  it("a list entry on another port or with an id of another box changes nothing", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    bed.run(OTHER_BOX);
    const mine = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site", 3000));
    const theirs = await bed.registry.start(OTHER_BOX, OWNER, bed.spec("site", 3001));
    const token = tokenFor(bed, theirs.id, OTHER_BOX);
    bed.lie((_op, answer) => ({
      services: (as(answer).services as object[]).map((service) => ({ ...service, id: theirs.id })),
    }));
    await bed.registry.refresh(PROJECT_BOX);
    expect(bed.registry.list(PROJECT_BOX)[0]?.id).toBe(mine.id);
    expect(bed.registry.byId(theirs.id)?.box).toEqual(OTHER_BOX);
    expect(bed.tokens.resolve("service", token)).not.toBeNull();
  });

  it("a start answered with an id already recorded in another box is refused, and nothing of the other box is revoked", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    bed.run(OTHER_BOX);
    const theirs = await bed.registry.start(OTHER_BOX, OWNER, bed.spec("site", 3001));
    const token = tokenFor(bed, theirs.id, OTHER_BOX);
    bed.lie((_op, answer) => ({ ...as(answer), id: theirs.id }));
    await expect(bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site", 3000))).rejects.toEqual(
      new PapError("internal"),
    );
    expect(bed.registry.list(PROJECT_BOX)).toEqual([]);
    expect(bed.registry.byId(theirs.id)?.box).toEqual(OTHER_BOX);
    expect(bed.tokens.resolve("service", token)).not.toBeNull();
  });
});
