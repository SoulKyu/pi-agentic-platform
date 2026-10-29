import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { AGENT_BOX, OTHER_BOX, PROJECT_BOX, registryBed } from "./testing/registry-bed.ts";

const OWNER = "u1";

/** A service token for the id, so a revocation shows as the token no longer resolving. */
function tokenFor(bed: ReturnType<typeof registryBed>, serviceId: string, box = PROJECT_BOX): string {
  return bed.tokens.mintService({ ownerId: OWNER, box, serviceId, port: 3000, sources: [] }).token;
}

describe("the previews registry", () => {
  it("the fifth service of a box is refused limit_reached before the guest is asked", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    for (const name of ["a", "b", "c", "d"])
      await bed.registry.start(PROJECT_BOX, OWNER, bed.spec(name, 3000));
    const asked = bed.calls.length;
    await expect(bed.registry.start(PROJECT_BOX, OWNER, bed.spec("e", 3001))).rejects.toEqual(
      new PapError("limit_reached"),
    );
    expect(bed.calls.length).toBe(asked);
  });

  it("a start of a running name is a restart, not a fifth service", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    for (const name of ["a", "b", "c", "d"]) await bed.registry.start(PROJECT_BOX, OWNER, bed.spec(name));
    const again = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a", 3002));
    expect(again.port).toBe(3002);
    expect(bed.registry.list(PROJECT_BOX)).toHaveLength(4);
  });

  it("a fifth name evicts the oldest dead record, as the guest does (restart of it answers not_found)", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    for (const name of ["a", "b", "c", "d"]) {
      await bed.registry.start(PROJECT_BOX, OWNER, bed.spec(name));
      await bed.clock.advance(10);
    }
    await bed.registry.stop(PROJECT_BOX, "b");
    await bed.registry.stop(PROJECT_BOX, "c");
    const fifth = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("e"));
    expect(
      bed.registry
        .list(PROJECT_BOX)
        .map((view) => view.name)
        .sort(),
    ).toEqual(["a", "c", "d", "e"]);
    expect(fifth.name).toBe("e");
    await expect(bed.registry.restart(PROJECT_BOX, "b")).rejects.toEqual(new PapError("not_found"));
    expect(bed.events.some(({ event }) => (event as { type: string; name?: string }).name === "b")).toBe(
      true,
    );
  });

  it("an exited report marks the record and revokes its tokens", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    const view = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    const token = tokenFor(bed, view.id);
    bed
      .guest(PROJECT_BOX)
      .link.report({ type: "service", id: view.id, state: "exited", code: 1, signal: null });
    expect(bed.registry.list(PROJECT_BOX)[0]).toMatchObject({ id: view.id, state: "exited" });
    expect(bed.tokens.resolve("service", token)).toBeNull();
    expect(bed.events.at(-1)).toMatchObject({
      ownerId: OWNER,
      event: { type: "service", service: { id: view.id, state: "exited", box: PROJECT_BOX } },
    });
  });

  it("a report for an id the registry does not know changes nothing and never throws", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    const before = bed.events.length;
    expect(() =>
      bed.guest(PROJECT_BOX).link.report({
        type: "service",
        id: "f".repeat(32),
        state: "exited",
        code: null,
        signal: null,
      }),
    ).not.toThrow();
    expect(bed.events.length).toBe(before);
  });

  it("a report whose handling throws is logged and never reaches the guest link", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    const view = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    bed.tokens.revokeService = () => {
      throw new Error("store down");
    };
    expect(() =>
      bed
        .guest(PROJECT_BOX)
        .link.report({ type: "service", id: view.id, state: "exited", code: 0, signal: null }),
    ).not.toThrow();
    expect(bed.lines.some((line) => line["msg"] === "preview_report_failed")).toBe(true);
  });

  it("a listener that throws on a change never reaches the guest link", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    const view = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    bed.registry.onChange(() => {
      throw new Error("boom");
    });
    expect(() =>
      bed
        .guest(PROJECT_BOX)
        .link.report({ type: "service", id: view.id, state: "exited", code: 0, signal: null }),
    ).not.toThrow();
    expect(bed.registry.list(PROJECT_BOX)[0]?.state).toBe("exited");
    expect(bed.lines.some((line) => line["msg"] === "preview_listener_failed")).toBe(true);
  });

  it("a restart revokes the old id's tokens and answers the new id", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    const first = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    const token = tokenFor(bed, first.id);
    const second = await bed.registry.restart(PROJECT_BOX, "site");
    expect(second.id).not.toBe(first.id);
    expect(bed.tokens.resolve("service", token)).toBeNull();
    expect(bed.registry.byId(first.id)).toBeNull();
    expect(bed.registry.byId(second.id)).toMatchObject({ ownerId: OWNER, box: PROJECT_BOX });
  });

  it("a start over a running name revokes the old id's tokens too", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    const first = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    const token = tokenFor(bed, first.id);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    expect(bed.tokens.resolve("service", token)).toBeNull();
  });

  it("a stop marks the record stopped and revokes its tokens; an unknown name is not stopped and asks nothing", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    const view = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    const token = tokenFor(bed, view.id);
    expect(await bed.registry.stop(PROJECT_BOX, "site")).toBe(true);
    expect(bed.registry.list(PROJECT_BOX)[0]?.state).toBe("stopped");
    expect(bed.tokens.resolve("service", token)).toBeNull();
    const asked = bed.calls.length;
    expect(await bed.registry.stop(PROJECT_BOX, "nothing")).toBe(false);
    expect(bed.calls.length).toBe(asked);
  });

  it("a stop the guest did not run reconciles with its list; a list that fails is logged, never silent", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    const guest = bed.guest(PROJECT_BOX);
    guest.services = guest.services.map((service) => ({ ...service, state: "exited" as const }));
    expect(await bed.registry.stop(PROJECT_BOX, "a")).toBe(false);
    expect(bed.registry.list(PROJECT_BOX)[0]?.state).toBe("exited");
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("b"));
    guest.services = guest.services.map((service) => ({ ...service, state: "exited" as const }));
    bed.failNext(new PapError("timeout"), 1);
    expect(await bed.registry.stop(PROJECT_BOX, "b")).toBe(false);
    expect(bed.lines.some((line) => line["msg"] === "preview_refresh_failed")).toBe(true);
  });

  it("a box stop drops its records, revokes its tokens and publishes removed", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    bed.run(OTHER_BOX);
    const a = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("b"));
    const other = await bed.registry.start(OTHER_BOX, OWNER, bed.spec("c"));
    const token = tokenFor(bed, a.id);
    const otherToken = tokenFor(bed, other.id, OTHER_BOX);
    bed.events.length = 0;
    bed.halt(PROJECT_BOX);
    expect(bed.registry.list(PROJECT_BOX)).toEqual([]);
    expect(bed.registry.list(OTHER_BOX)).toHaveLength(1);
    expect(bed.tokens.resolve("service", token)).toBeNull();
    expect(bed.tokens.resolve("service", otherToken)).not.toBeNull();
    expect(bed.events.map(({ event }) => event)).toEqual([
      { type: "removed", box: PROJECT_BOX, name: "a" },
      { type: "removed", box: PROJECT_BOX, name: "b" },
    ]);
  });

  it("the link closing drops the box's records like a stop", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    const view = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    const token = tokenFor(bed, view.id);
    bed.events.length = 0;
    bed.guest(PROJECT_BOX).link.close();
    await bed.clock.advance(0);
    expect(bed.registry.list(PROJECT_BOX)).toEqual([]);
    expect(bed.tokens.resolve("service", token)).toBeNull();
    expect(bed.events.map(({ event }) => event)).toEqual([{ type: "removed", box: PROJECT_BOX, name: "a" }]);
  });

  it("a late close of an old link never drops the next VM's records", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    const old = bed.guest(PROJECT_BOX).link;
    bed.halt(PROJECT_BOX);
    bed.run(PROJECT_BOX);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("b"));
    old.close();
    await bed.clock.advance(0);
    expect(bed.registry.list(PROJECT_BOX).map((view) => view.name)).toEqual(["b"]);
  });

  it("a start answered after the box stopped is box_stopped and records nothing", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    const pending = bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    bed.halt(PROJECT_BOX);
    await expect(pending).rejects.toEqual(new PapError("box_stopped"));
    expect(bed.registry.list(PROJECT_BOX)).toEqual([]);
  });

  it("a stopped box answers box_stopped to a start and the registry stays empty", async () => {
    const bed = registryBed();
    await expect(bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"))).rejects.toEqual(
      new PapError("box_stopped"),
    );
    expect(bed.registry.all(OWNER)).toEqual([]);
  });

  it("the guest's conflict (a hidden starting record counts toward the cap) reads limit_reached", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    bed.failNext(new PapError("conflict"));
    await expect(bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"))).rejects.toEqual(
      new PapError("limit_reached"),
    );
  });

  it("list and logs use poll, start uses call", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    await bed.registry.refresh(PROJECT_BOX);
    await bed.registry.logs(PROJECT_BOX, "a");
    await bed.registry.stop(PROJECT_BOX, "a");
    await bed.registry.restart(PROJECT_BOX, "a");
    expect(bed.calls.map((call) => [call.via, call.op.name])).toEqual([
      ["call", "svc.start"],
      ["poll", "svc.list"],
      ["poll", "svc.logs"],
      ["call", "svc.stop"],
      ["call", "svc.restart"],
    ]);
  });

  it("logs come back redacted", async () => {
    const vault = "sk-vault-value-1234567890";
    const bed = registryBed({ redact: async (line) => line.split(vault).join("[REDACTED]") });
    bed.run(PROJECT_BOX);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    bed.guest(PROJECT_BOX).logs.set("a", ["listening", `token=${vault}`]);
    expect(await bed.registry.logs(PROJECT_BOX, "a")).toEqual(["listening", "token=[REDACTED]"]);
  });

  it("a redactor that fails gives no line at all", async () => {
    const bed = registryBed({
      redact: async () => {
        throw new Error("collector down");
      },
    });
    bed.run(PROJECT_BOX);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    bed.guest(PROJECT_BOX).logs.set("a", ["secret line"]);
    await expect(bed.registry.logs(PROJECT_BOX, "a")).rejects.toEqual(new PapError("internal"));
  });

  it("logs and restart of an unknown name are not_found on a running box, box_stopped on a stopped one", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    await expect(bed.registry.logs(PROJECT_BOX, "nope")).rejects.toEqual(new PapError("not_found"));
    await expect(bed.registry.restart(PROJECT_BOX, "nope")).rejects.toEqual(new PapError("not_found"));
    await expect(bed.registry.logs(OTHER_BOX, "nope")).rejects.toEqual(new PapError("box_stopped"));
  });

  it("refresh follows the guest: a record it dropped is removed, a changed one is updated", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    const a = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("b"));
    const guest = bed.guest(PROJECT_BOX);
    guest.services = guest.services
      .filter((service) => service.name !== "b")
      .map((service) => ({ ...service, state: "exited" as const }));
    const token = tokenFor(bed, a.id);
    const views = await bed.registry.refresh(PROJECT_BOX);
    expect(views.map((view) => [view.name, view.state])).toEqual([["a", "exited"]]);
    expect(bed.tokens.resolve("service", token)).toBeNull();
  });

  it("all(owner) lists only that owner's boxes, with the box, at most 256", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    bed.run(AGENT_BOX);
    await bed.registry.start(PROJECT_BOX, "u1", bed.spec("mine"));
    await bed.registry.start(AGENT_BOX, "u2", bed.spec("theirs"));
    expect(bed.registry.all("u1").map((view) => [view.name, view.box])).toEqual([["mine", PROJECT_BOX]]);
    expect(bed.registry.all("u2").map((view) => [view.name, view.box])).toEqual([["theirs", AGENT_BOX]]);
    expect(bed.registry.all("u3")).toEqual([]);
  });

  it("close stops listening to the runtime", async () => {
    const bed = registryBed();
    bed.run(PROJECT_BOX);
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("a"));
    bed.registry.close();
    bed.halt(PROJECT_BOX);
    expect(bed.registry.list(PROJECT_BOX)).toHaveLength(1);
  });
});
