import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_TTL_MS } from "./access.ts";
import { OWNER } from "./testing/bed.ts";
import { type ProjectsBed, startProjectsBed } from "./testing/projects-bed.ts";

let bed: ProjectsBed;
beforeEach(async () => {
  bed = await startProjectsBed({
    "git.commit": () => ({ sha: "abc1234" as string | null }),
    "git.push": () => ({ branch: "feat/x", remote: "origin" }),
  });
});
afterEach(() => bed.close());

const rpc = () => bed.feature.rpc;
const ctx = () => ({ caller: bed.caller }) as never;

function linked(): string {
  const id = bed.create();
  bed.store.put({
    projectId: id,
    ownerId: OWNER,
    repository: "octo/hello",
    upstream: null,
    fork: false,
    cloneState: "done",
  });
  return id;
}

describe("every installation token goes through the owner's access check", () => {
  it("while the access holds, the lists, a check log and a pull request work", async () => {
    const id = linked();
    await expect(rpc()["projects.github"]({ projectId: id }, ctx())).resolves.toBeDefined();
    await expect(
      rpc()["projects.prCreate"]({ projectId: id, title: "t", body: "b" }, ctx()),
    ).resolves.toMatchObject({ kind: "created" });
  });

  it("once the access is lost, prCreate, the lists and checkLog answer not_found with no new mint", async () => {
    const id = linked();
    await rpc()["projects.github"]({ projectId: id }, ctx());
    const minted = bed.fake.state.minted.length;
    bed.fake.state.access.restrict("octo/hello", {});
    await bed.clock.advance(ACCESS_TTL_MS);

    await expect(rpc()["projects.github"]({ projectId: id }, ctx())).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(rpc()["projects.checkLog"]({ projectId: id, checkId: "12" }, ctx())).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      rpc()["projects.prCreate"]({ projectId: id, title: "t", body: "b" }, ctx()),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      rpc()["projects.sendToSession"]({ projectId: id, source: { kind: "issue", number: 1 } }, ctx()),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(bed.fake.state.minted).toHaveLength(minted);
    expect(bed.sessionCalls).toEqual([]);
  });

  it("no module code mints except through mintFor", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => readFileSync(join(dir, name), "utf8").includes("tokens.mint("))
      .filter((name) => name !== "index.ts");
    expect(offenders).toEqual([]);
  });
});
