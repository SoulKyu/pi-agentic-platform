import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("signing keys of a deleted member (A5b, RT-12c)", () => {
  it("releaseKeysOf has removed every key from GitHub by the time it answers", async () => {
    const id = await running();
    expect(bed.fake.state.signingKeys.size).toBe(1);
    expect(await bed.feature.service.releaseKeysOf(bed.caller.userId)).toEqual([]);
    expect(bed.fake.state.signingKeys.size).toBe(0);
    expect(bed.store.get(id)).toBeUndefined();
  });

  it("names the keys GitHub kept, and the delete is not stopped by them", async () => {
    const id = await running();
    const keyId = bed.store.get(id)?.keyId;
    bed.fake.state.fail("DELETE /user/ssh_signing_keys/:id", 500, "down");
    expect(await bed.feature.service.releaseKeysOf(bed.caller.userId)).toEqual([keyId]);
    expect(bed.fake.state.signingKeys.size).toBe(1);
  });

  it("touches no other owner's key", async () => {
    await running();
    expect(await bed.feature.service.releaseKeysOf("someone-else")).toEqual([]);
    expect(bed.fake.state.signingKeys.size).toBe(1);
  });
});
