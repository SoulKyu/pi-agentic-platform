import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeVmd } from "./testing/fake-vmd.ts";
import { disposeProject, purgeProject, startTrashSweep } from "./index.ts";
import { TRASH_KEEP_MS } from "./trash.ts";

const A = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
const B = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d12";
let root: string;
let clock: FakeClock;

const trash = () => join(root, "boxes", ".trash");
const put = (path: string) => {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "s.jsonl"), "x");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-a6-trash-"));
  clock = createFakeClock(Date.UTC(2026, 9, 20));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a project box's trash", () => {
  it("moves the mirrors under boxes/.trash and never the agents' ones", async () => {
    put(join(root, "boxes", ".mirrors", A));
    put(join(root, "agents", ".mirrors", "scout-0001"));
    await disposeProject({ client: null, papHome: root, clock, logger: silentLogger }, A, 1_760_000_000_000);
    expect(existsSync(join(trash(), `${A}-1760000000000.mirrors`, "s.jsonl"))).toBe(true);
    expect(existsSync(join(root, "agents", ".mirrors", "scout-0001"))).toBe(true);
  });

  it("refuses a name that is not a project id", async () => {
    const deps = { client: null, papHome: root, clock, logger: silentLogger };
    await expect(disposeProject(deps, "scout-0001", 1)).rejects.toMatchObject({ code: "bad_request" });
    await expect(purgeProject(deps, "../x")).rejects.toMatchObject({ code: "bad_request" });
  });

  it("purges one project's entries, not another's", async () => {
    put(join(trash(), `${A}-1760000000000.mirrors`));
    put(join(trash(), `${B}-1760000000000.mirrors`));
    await purgeProject({ client: createFakeVmd(), papHome: root, clock, logger: silentLogger }, A);
    expect(existsSync(join(trash(), `${A}-1760000000000.mirrors`))).toBe(false);
    expect(existsSync(join(trash(), `${B}-1760000000000.mirrors`))).toBe(true);
  });

  it("is swept after 7 days with the agents' trash", () => {
    const old = clock.now() - TRASH_KEEP_MS - 1;
    const young = clock.now() - 1000;
    put(join(trash(), `${A}-${old}.mirrors`));
    put(join(trash(), `${B}-${young}.mirrors`));
    put(join(trash(), `not-a-project-${old}.mirrors`));
    const stop = startTrashSweep({ client: null, papHome: root, clock, logger: silentLogger });
    stop();
    expect(existsSync(join(trash(), `${A}-${old}.mirrors`))).toBe(false);
    expect(existsSync(join(trash(), `${B}-${young}.mirrors`))).toBe(true);
    expect(existsSync(join(trash(), `not-a-project-${old}.mirrors`))).toBe(true);
  });
});
