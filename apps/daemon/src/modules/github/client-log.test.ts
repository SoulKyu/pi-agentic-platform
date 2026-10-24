import { lookup as dnsLookup } from "node:dns";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_LIMITS } from "@pap/contracts";
import { createJobLog } from "./client-log.ts";
import { type GithubBed, startGithubBed } from "./testing/bed.ts";

let bed: GithubBed;
beforeEach(async () => {
  bed = await startGithubBed();
});
afterEach(() => bed.close());

const KEY = "octo/hello#11";
const PATH = "/repos/octo/hello/actions/jobs/11/logs";
const auth = { kind: "bearer", value: "ghs_secret" } as const;
const log = () => bed.core.client.log(PATH, auth);
const data = () => bed.fake.state.data;
const blobCalls = () => bed.fake.state.callsTo("GET /blob/:id");

describe("job log redirect", () => {
  it("follows one redirect and sends no Authorization to the second host", async () => {
    data().logLocations.set(KEY, `${bed.fake.origin}/blob/1`);
    data().blobs.set("1", "from storage");
    expect(await log()).toEqual({ text: "from storage", truncated: false });
    const first = bed.fake.state.callsTo("GET /repos/:o/:r/actions/jobs/:id/logs")[0];
    expect(first?.authorization).toBe("Bearer ghs_secret");
    expect(blobCalls()).toHaveLength(1);
    expect(blobCalls()[0]?.authorization).toBeNull();
  });

  it("returns the last 64 KiB of a log over 4 MiB", async () => {
    data().logLocations.set(KEY, `${bed.fake.origin}/blob/big`);
    data().blobs.set("big", `HEAD${"é".repeat(2_600_000)}TAIL`);
    const out = await log();
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(GITHUB_LIMITS.checkLogBytes);
    expect(Buffer.byteLength(out.text)).toBeGreaterThan(GITHUB_LIMITS.checkLogBytes - 4);
    expect(out.text.endsWith("TAIL")).toBe(true);
    expect(out.text).not.toContain("�");
  });

  it.each([
    ["http", "http://logs.actions.githubusercontent.com/a"],
    ["userinfo", "https://u:p@logs.actions.githubusercontent.com/a"],
    ["an IP literal", "https://127.0.0.1/a"],
    ["an IPv6 literal", "https://[::1]/a"],
    ["a host off the list", "https://evil.example/a"],
    ["a look-alike host", "https://logs.actions.githubusercontent.com.evil.example/a"],
    ["a relative Location", "/blob/1"],
  ])("refuses a redirect to %s, naming no URL in the log", async (_name, location) => {
    data().logLocations.set(KEY, location);
    await expect(log()).rejects.toMatchObject({ code: "github_unavailable" });
    expect(blobCalls()).toEqual([]);
    expect(JSON.stringify(bed.lines)).not.toContain("evil.example");
  });

  it("refuses a second redirect", async () => {
    data().logLocations.set(KEY, `${bed.fake.origin}/blob/1`);
    bed.fake.state.respond("GET /blob/:id", {
      status: 302,
      headers: { location: `${bed.fake.origin}/blob/2` },
    });
    await expect(log()).rejects.toMatchObject({ code: "github_unavailable" });
    expect(blobCalls()).toHaveLength(1);
  });

  it("refuses a storage host that resolves to a blocked address, connecting nowhere", async () => {
    data().logLocations.set(KEY, "https://logs.actions.githubusercontent.com/a");
    const fetchLog = createJobLog({
      clock: bed.clock,
      apiOrigin: bed.fake.origin,
      webOrigin: bed.fake.origin,
      test: true,
      allow: () => true,
      keep: GITHUB_LIMITS.checkLogBytes,
      lookup: (host: string, opts: object, done: (...args: never[]) => void) =>
        host === "logs.actions.githubusercontent.com"
          ? (done as (e: Error) => void)(Object.assign(new Error("address refused"), { code: "EGITHUBADDR" }))
          : dnsLookup(host, opts as never, done as never),
    });
    await expect(fetchLog(PATH, { value: "ghs_secret" })).rejects.toMatchObject({
      code: "github_unavailable",
    });
    expect(blobCalls()).toEqual([]);
  });

  it("a plain 200 log and a missing job still work", async () => {
    data().jobLogs.set(KEY, "direct");
    expect(await log()).toEqual({ text: "direct", truncated: false });
    await expect(
      bed.core.client.log("/repos/octo/hello/actions/jobs/99/logs", auth).then(() => "ok"),
    ).resolves.toBe("ok");
    bed.fake.state.fail("GET /repos/:o/:r/actions/jobs/:id/logs", 404);
    await expect(log()).rejects.toMatchObject({ code: "not_found" });
  });
});
