import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_LIMITS } from "@pap/contracts";
import { OWNER } from "./testing/bed.ts";
import { tailText } from "./client-log.ts";
import { type ProjectsBed, startProjectsBed } from "./testing/projects-bed.ts";

let bed: ProjectsBed;
let id: string;
beforeEach(async () => {
  bed = await startProjectsBed();
  id = bed.create();
  bed.store.put({
    projectId: id,
    ownerId: OWNER,
    repository: "octo/hello",
    upstream: null,
    fork: false,
    cloneState: "done",
  });
});
afterEach(() => bed.close());

const log = (checkId: string) =>
  bed.feature.rpc["projects.checkLog"]({ projectId: id, checkId }, { caller: bed.caller } as never);

describe("check log", () => {
  it("keeps the last 64 KiB", async () => {
    bed.fake.state.data.jobLogs.set("octo/hello#11", `HEAD${"x".repeat(GITHUB_LIMITS.checkLogBytes)}TAIL`);
    const out = await log("11");
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text)).toBe(GITHUB_LIMITS.checkLogBytes);
    expect(out.text.endsWith("TAIL")).toBe(true);
    expect(out.text.startsWith("HEAD")).toBe(false);
  });

  it("returns a short log whole, and refuses a non-numeric check id", async () => {
    bed.fake.state.data.jobLogs.set("octo/hello#12", "all good");
    expect(await log("12")).toEqual({ text: "all good", truncated: false });
    await expect(log("../x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("cuts on a character boundary", () => {
    const text = "é".repeat(10);
    const out = tailText(Buffer.from(text), 5, true);
    expect(out.truncated).toBe(true);
    expect(out.text).toBe("éé");
  });
});
