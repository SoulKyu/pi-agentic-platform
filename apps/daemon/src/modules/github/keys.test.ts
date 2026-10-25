import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SWEEP_MS } from "./keys.ts";
import { OWNER } from "./testing/bed.ts";
import { eventually, type ProjectsBed, startProjectsBed } from "./testing/projects-bed.ts";

let bed: ProjectsBed;
beforeEach(async () => {
  bed = await startProjectsBed();
});
afterEach(() => bed.close());

async function running(): Promise<string> {
  const { project } = await bed.feature.service.createFromGithub(bed.caller, {
    repository: "octo/hello",
    mode: "clone",
  });
  bed.control.setPhase(project.id, "running");
  await eventually(() => expect(bed.store.get(project.id)?.keyState).toBe("added"));
  return project.id;
}
const keyCalls = (route: string) => bed.fake.state.callsTo(route);

describe("signing keys", () => {
  it("adds the key once", async () => {
    const id = await running();
    expect(bed.store.get(id)?.keyId).toBe([...bed.fake.state.signingKeys.keys()][0]);
    bed.control.setPhase(id, "stopped");
    bed.control.setPhase(id, "running");
    await eventually(() =>
      expect(bed.opNames().filter((name) => name === "github.identity")).toHaveLength(2),
    );
    expect(keyCalls("POST /user/ssh_signing_keys")).toHaveLength(1);
    expect(bed.fake.state.signingKeys.size).toBe(1);
  });

  it("removes it on delete", async () => {
    const id = await running();
    await bed.projects.rpc["projects.delete"]({ projectId: id }, { caller: bed.caller } as Parameters<
      (typeof bed.projects.rpc)["projects.delete"]
    >[1]);
    await eventually(() => expect(bed.fake.state.signingKeys.size).toBe(0));
    await eventually(() => expect(bed.store.get(id)).toBeUndefined());
    // The box token still live in the box is revoked too.
    await eventually(() => expect(bed.fake.state.revoked).toEqual([bed.fake.state.minted[0]?.token]));
  });

  it("removes it on unlink, and tells the box", async () => {
    const id = await running();
    await bed.feature.service.unlinkGithub(bed.caller, id);
    expect(bed.opNames().slice(-2)).toEqual(["git.unlink", "github.forgetKey"]);
    expect(bed.fake.state.signingKeys.size).toBe(0);
    expect(bed.store.get(id)).toBeUndefined();
    // The box token last delivered is revoked; a revoke that fails is only logged, with a fixed word.
    expect(bed.fake.state.revoked).toEqual([bed.fake.state.minted[0]?.token]);
    // The renewal stops with the link.
    const tokens = bed.opNames().filter((name) => name === "github.token").length;
    await bed.clock.advance(45 * 60_000 * 2);
    expect(bed.opNames().filter((name) => name === "github.token")).toHaveLength(tokens);
  });

  it("a revoke GitHub refuses never fails the unlink", async () => {
    const id = await running();
    bed.fake.state.fail("DELETE /installation/token", 500, "token-secret-words");
    await bed.feature.service.unlinkGithub(bed.caller, id);
    expect(bed.store.get(id)).toBeUndefined();
    expect(bed.lines.some((line) => line.msg === "github_token_revoke_failed")).toBe(true);
    expect(JSON.stringify(bed.lines)).not.toContain("token-secret-words");
  });

  it("retries a failed removal in the sweep", async () => {
    const id = await running();
    bed.fake.state.fail("DELETE /user/ssh_signing_keys/:id", 500, "down", 1);
    await bed.feature.service.unlinkGithub(bed.caller, id);
    expect(bed.store.get(id)).toMatchObject({ linked: false, keyState: "failed" });
    expect(bed.fake.state.signingKeys.size).toBe(1);
    // Unlinked as far as the project goes, the key still listed for the sweep.
    expect(bed.feature.service.view(bed.row(id))).toMatchObject({ link: null, key: "failed" });

    await bed.clock.advance(SWEEP_MS);
    await eventually(() => expect(bed.fake.state.signingKeys.size).toBe(0));
    await eventually(() => expect(bed.store.get(id)).toBeUndefined());
  });

  it("keeps trying every day while GitHub keeps refusing", async () => {
    const id = await running();
    bed.fake.state.fail("DELETE /user/ssh_signing_keys/:id", 500, "down", 2);
    await bed.feature.service.unlinkGithub(bed.caller, id);
    await bed.clock.advance(SWEEP_MS);
    await eventually(() => expect(keyCalls("DELETE /user/ssh_signing_keys/:id")).toHaveLength(2));
    await eventually(() => expect(bed.store.get(id)?.keyState).toBe("failed"));
    await bed.clock.advance(SWEEP_MS);
    await eventually(() => expect(bed.fake.state.signingKeys.size).toBe(0));
  });

  it("a key the owner already removed on GitHub counts as removed", async () => {
    const id = await running();
    bed.fake.state.signingKeys.clear();
    await bed.feature.service.unlinkGithub(bed.caller, id);
    expect(bed.store.get(id)).toBeUndefined();
  });

  it("403 sets permissionMissing, and a reconnect clears it", async () => {
    bed.fake.state.fail("POST /user/ssh_signing_keys", 403, "Resource not accessible by integration");
    const { project } = await bed.feature.service.createFromGithub(bed.caller, {
      repository: "octo/hello",
      mode: "clone",
    });
    bed.control.setPhase(project.id, "running");
    await eventually(() => expect(bed.store.get(project.id)?.cloneState).toBe("done"));
    expect(bed.store.get(project.id)).toMatchObject({ keyState: "absent", keyId: null });
    expect((await bed.account.service.status(bed.caller, undefined)).permissionMissing).toBe(true);
    expect(bed.lines.some((line) => line.msg === "github_key_permission_missing")).toBe(true);
    // The box still got its token and its clone: only the key waits.
    expect(bed.opNames()).toContain("git.clone");

    // The owner fixes the permission and reconnects: the flag clears, and the next start uploads the key.
    bed.fake.state.respond("POST /user/ssh_signing_keys", { status: 201, body: { id: 77 } }, 0);
    const state = bed.core.states.issue(OWNER, "authorize");
    const exchanged = await bed.account.service.completeAuthorize("code-2", state);
    if (exchanged.kind !== "exchanged") throw new Error("not exchanged");
    expect(bed.account.service.finishAuthorize(exchanged.ticket, OWNER).kind).toBe("authorized");
    expect((await bed.account.service.status(bed.caller, undefined)).permissionMissing).toBe(false);
    bed.control.setPhase(project.id, "stopped");
    bed.control.setPhase(project.id, "running");
    await eventually(() => expect(bed.store.get(project.id)?.keyState).toBe("added"));
    expect((await bed.account.service.status(bed.caller, undefined)).permissionMissing).toBe(false);
  });

  it("a rate limit on the upload is not a missing permission", async () => {
    bed.fake.state.respond(
      "POST /user/ssh_signing_keys",
      { status: 403, body: { message: "rate limit" }, headers: { "x-ratelimit-remaining": "0" } },
      1,
    );
    const id = bed.create();
    bed.control.setPhase(id, "running");
    await bed.feature.service.linkGithub(bed.caller, { projectId: id, repository: "octo/hello" });
    expect(bed.store.get(id)).toMatchObject({ keyState: "absent", keyId: null });
    expect((await bed.account.service.status(bed.caller, undefined)).permissionMissing).toBe(false);
    expect(
      bed.lines.some((line) => line.msg === "github_key_upload_failed" && line.code === "capacity"),
    ).toBe(true);
  });

  it("release reads the row as it is: a key uploaded meanwhile is removed", async () => {
    const id = await running();
    const stale = { ...bed.row(id), keyId: null, keyState: "absent" as const };
    await bed.feature.keys.release(stale);
    expect(bed.fake.state.signingKeys.size).toBe(0);
    expect(bed.store.get(id)).toBeUndefined();
  });
});
