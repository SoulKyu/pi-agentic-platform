import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RENEW_MS, RETRY_MS } from "./deliver.ts";
import { eventually, type ProjectsBed, PUBLIC_KEY, startProjectsBed } from "./testing/projects-bed.ts";

let bed: ProjectsBed;
afterEach(() => bed.close());

async function cloned(): Promise<string> {
  const { project } = await bed.feature.service.createFromGithub(bed.caller, {
    repository: "octo/hello",
    mode: "clone",
  });
  return project.id;
}
const count = (name: string): number => bed.opNames().filter((one) => one === name).length;

describe("delivery", () => {
  it("running delivers token, identity and clone once", async () => {
    bed = await startProjectsBed();
    const id = await cloned();
    bed.control.setPhase(id, "running");
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("done"));

    expect(bed.opNames()).toEqual(["github.token", "github.identity", "fs.list", "git.clone"]);
    const [token, identity] = bed.ops.all.map((call) => call.op);
    const minted = bed.fake.state.minted[0];
    expect(token).toMatchObject({ name: "github.token", token: minted?.token });
    expect(Date.parse((token as { expiresAt: string }).expiresAt)).toBeGreaterThan(bed.clock.now());
    expect(identity).toEqual({
      name: "github.identity",
      login: "octo",
      displayName: "Octo Cat",
      email: "1+octo@users.noreply.github.com",
    });
    expect(bed.ops.all.find((call) => call.op.name === "fs.list")?.op).toMatchObject({
      path: `/boxes/${id}/project`,
    });
    expect(bed.ops.all.every((call) => call.projectId === id)).toBe(true);
    expect([...bed.fake.state.signingKeys.values()]).toEqual([
      { title: `pap hello ${id.slice(0, 8)}`, key: PUBLIC_KEY },
    ]);

    // A restart delivers a fresh token, but the clone and the key were done: neither repeats.
    bed.control.setPhase(id, "stopped");
    bed.control.setPhase(id, "running");
    await eventually(() => expect(count("github.token")).toBe(2));
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("done"));
    expect(count("git.clone")).toBe(1);
    expect(bed.fake.state.signingKeys.size).toBe(1);
  });

  it("renews every 45 minutes while the box runs", async () => {
    bed = await startProjectsBed();
    const id = await cloned();
    bed.control.setPhase(id, "running");
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("done"));
    expect(count("github.token")).toBe(1);

    await bed.clock.advance(RENEW_MS);
    await eventually(() => expect(count("github.token")).toBe(2));
    await bed.clock.advance(RENEW_MS);
    await eventually(() => expect(count("github.token")).toBe(3));
    // A renewal sends the token only: the identity and the clone were done at the start.
    expect(count("github.identity")).toBe(1);
    expect(count("git.clone")).toBe(1);

    bed.control.setPhase(id, "stopped");
    await bed.clock.advance(RENEW_MS * 2);
    expect(count("github.token")).toBe(3);
  });

  it("delivery polls: no step of it, a renewal or a retry included, resets the box's idle wait", async () => {
    let failures = 1;
    bed = await startProjectsBed({
      "github.token": () => {
        if (failures-- > 0) throw new PapError("timeout");
        return { ok: true as const };
      },
    });
    const id = await cloned();
    bed.control.setPhase(id, "running");
    await eventually(() => expect(count("github.token")).toBe(1));
    await bed.clock.advance(RETRY_MS);
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("done"));
    await bed.clock.advance(RENEW_MS);
    await eventually(() => expect(count("github.token")).toBe(3));
    expect(bed.ops.calls.map((call) => call.op.name)).toEqual([]);
    expect(new Set(bed.ops.polls.map((call) => call.op.name))).toEqual(
      new Set(["github.token", "github.identity", "fs.list", "git.clone"]),
    );
  });

  it("a box token never has administration", async () => {
    bed = await startProjectsBed();
    const id = await cloned();
    bed.control.setPhase(id, "running");
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("done"));
    await bed.clock.advance(RENEW_MS);
    await eventually(() => expect(bed.fake.state.minted).toHaveLength(2));
    for (const minted of bed.fake.state.minted) {
      expect(minted.permissions).toEqual({ contents: "write", pull_requests: "write" });
      expect(minted.repositories).toEqual(["octo/hello"]);
    }
  });

  it("a delivery failure is logged with a fixed code and retried at the next tick, never thrown into the start", async () => {
    let failures = 1;
    bed = await startProjectsBed({
      "github.token": () => {
        if (failures-- > 0) throw new PapError("timeout");
        return { ok: true as const };
      },
    });
    const id = await cloned();
    expect(() => bed.control.setPhase(id, "running")).not.toThrow();
    await eventually(() =>
      expect(bed.lines.some((line) => line.msg === "github_delivery_failed")).toBe(true),
    );
    const failed = bed.lines.find((line) => line.msg === "github_delivery_failed");
    expect(failed).toMatchObject({ step: "token", code: "timeout", projectId: id });
    // Without a token nothing else goes: the clone of a private repository would fail for good.
    expect(bed.opNames()).toEqual(["github.token"]);
    expect(bed.store.get(id)?.cloneState).toBe("pending");

    // A minute later, not 45: the token, then the rest of the delivery.
    await bed.clock.advance(RETRY_MS);
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("done"));
    expect(count("github.token")).toBe(2);
    expect(count("github.identity")).toBe(1);
    // And back to the 45 minutes.
    await bed.clock.advance(RETRY_MS);
    expect(count("github.token")).toBe(2);
    // The renewal was armed at minute 1: it falls due at minute 46, and not a request timer more.
    await bed.clock.advance(RENEW_MS - RETRY_MS);
    await eventually(() => expect(count("github.token")).toBe(3));
    const text = JSON.stringify(bed.lines);
    for (const minted of bed.fake.state.minted) expect(text).not.toContain(minted.token);
  });

  it("the stop of bind clears the armed renewals", async () => {
    bed = await startProjectsBed();
    const id = await cloned();
    bed.control.setPhase(id, "running");
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("done"));
    const armed = bed.clock.pending();
    bed.stopDelivery();
    expect(bed.clock.pending()).toBe(armed - 1);
    await bed.clock.advance(RENEW_MS * 2);
    expect(count("github.token")).toBe(1);
  });

  it("cloneAgain on a folder that holds files is a conflict and changes nothing", async () => {
    const entry = {
      name: "partial",
      kind: "dir" as const,
      size: null,
      mtimeMs: 1,
      hidden: null,
      protected: false,
      link: null,
      linkDir: false,
    };
    let files = false;
    bed = await startProjectsBed({
      "fs.list": () => ({ entries: files ? [entry] : [], truncated: false }),
      "git.clone": () => {
        throw new PapError("timeout");
      },
    });
    const id = await cloned();
    await expect(bed.feature.service.cloneAgain(bed.caller, id)).rejects.toMatchObject({ code: "conflict" });
    bed.control.setPhase(id, "running");
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("failed"));
    await bed.feature.service.cloneAgain(bed.caller, id).catch(() => undefined);
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("failed"));
    files = true;
    await expect(bed.feature.service.cloneAgain(bed.caller, id)).rejects.toMatchObject({ code: "conflict" });
    expect(bed.store.get(id)).toMatchObject({ cloneState: "failed", cloneError: "network" });
    bed.control.setPhase(id, "stopped");
    await expect(bed.feature.service.cloneAgain(bed.caller, id)).rejects.toMatchObject({
      code: "box_stopped",
    });
  });

  it("a failed clone stores a fixed word, leaves the project empty and clones again on request", async () => {
    let fail: PapError | null = new PapError("not_found");
    bed = await startProjectsBed({
      "git.clone": () => {
        if (fail) throw fail;
        return { branch: "main" };
      },
    });
    const id = await cloned();
    bed.control.setPhase(id, "running");
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("failed"));
    expect(bed.store.get(id)?.cloneError).toBe("not_found");
    expect(bed.feature.service.view(bed.row(id)).clone).toEqual({ state: "failed", error: "not_found" });

    fail = null;
    await bed.feature.service.cloneAgain(bed.caller, id);
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("done"));
    expect(bed.store.get(id)?.cloneError).toBeNull();
    expect(count("git.clone")).toBe(2);
    // Nothing to retry now.
    await expect(bed.feature.service.cloneAgain(bed.caller, id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("a box that stopped mid-clone keeps the row pending", async () => {
    bed = await startProjectsBed({
      "git.clone": () => {
        throw new PapError("box_stopped");
      },
    });
    const id = await cloned();
    bed.control.setPhase(id, "running");
    await eventually(() => expect(bed.lines.some((line) => line.step === "clone")).toBe(true));
    expect(bed.store.get(id)).toMatchObject({ cloneState: "pending", cloneError: null });
  });

  it("a folder that already holds files is not cloned over", async () => {
    const entry = {
      name: "notes.md",
      kind: "file" as const,
      size: 1,
      mtimeMs: 1,
      hidden: null,
      protected: false,
      link: null,
      linkDir: false,
    };
    bed = await startProjectsBed({ "fs.list": () => ({ entries: [entry], truncated: false }) });
    const id = await cloned();
    bed.control.setPhase(id, "running");
    await eventually(() => expect(bed.store.get(id)?.cloneState).toBe("done"));
    expect(count("git.clone")).toBe(0);
  });
});
