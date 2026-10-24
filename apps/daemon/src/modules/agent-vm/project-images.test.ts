import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { BUILD_NOTICE } from "./image-policy.ts";
import { createKataImages } from "./kata-images.ts";
import { createProjectImages } from "./index.ts";
import { runProfileJob } from "./profile-job.ts";
import { createFakeVmd, type FakeVmd } from "./testing/fake-vmd.ts";

const NODE = `docker.io/library/node@sha256:${"9".repeat(64)}`;
const PROJECT = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
let root: string;
let fake: FakeVmd;
let notices: Array<[string, string]>;
let warnings: string[];
let images: ReturnType<typeof createKataImages>;

const file = () => join(root, "pap", "vm", "project-images.json");
const make = () =>
  createProjectImages({
    images,
    logger: { warn: (event) => void warnings.push(event) },
    notice: (id, text) => void notices.push([id, text]),
    file: file(),
  });
const layers = () => fake.of("image.build").map((build) => build.layer);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-a6-images-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "bundle"), { recursive: true });
  writeFileSync(join(root, "bundle", "package.json"), "{}");
  writeFileSync(join(root, "agent", "settings.json"), "{}");
  fake = createFakeVmd();
  notices = [];
  warnings = [];
  images = createKataImages({
    client: fake,
    clock: createFakeClock(Date.UTC(2026, 9, 20)),
    logger: silentLogger,
    papHome: join(root, "pap"),
    agentDir: join(root, "agent"),
    bundleRoot: join(root, "bundle"),
    nodeImage: NODE,
    weekFile: join(root, "pap", "vm", "base-week"),
    secrets: () => [],
    entries: { record: () => {}, forget: () => {}, held: () => [] },
    profileRunner: (job) => Promise.resolve(runProfileJob(job)),
    notice: (id, text) => void notices.push([id, text]),
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("project images", () => {
  it("a project with no packages runs on the profile tag", async () => {
    const tag = await make().tagOf(PROJECT);
    expect(layers()).toEqual(["base", "profile"]);
    expect(tag).toBe(fake.of("image.build").find((build) => build.layer === "profile")?.tag);
  });

  it("new packages build behind and apply at the next start", async () => {
    const projects = make();
    const profile = await projects.tagOf(PROJECT);
    images.started(PROJECT, profile);
    projects.setWanted(PROJECT, ["jq", "make"]);
    expect(projects.packages(PROJECT)).toEqual({ built: [], wanted: ["jq", "make"] });
    expect(await projects.tagOf(PROJECT)).toBe(profile); // no rebuild yet: the running image

    expect(projects.packages(PROJECT).built).toEqual([]);
    await projects.rebuild(PROJECT, true); // answers when the image exists; the box keeps running on the old one
    const agent = fake.of("image.build").find((build) => build.layer === "agent");
    expect(agent).toMatchObject({ aptPackages: ["jq", "make"] });
    expect(notices).toEqual([[PROJECT, BUILD_NOTICE]]);
    expect(projects.packages(PROJECT).built).toEqual(["jq", "make"]); // only now
    expect(await projects.tagOf(PROJECT)).toBe(profile); // the box still runs on the old image

    images.stopped(PROJECT);
    expect(await projects.tagOf(PROJECT)).toBe(agent?.tag);
    expect(projects.packages(PROJECT)).toEqual({ built: ["jq", "make"], wanted: ["jq", "make"] });
  });

  it("a failed build leaves built as it was, logs once and throws", async () => {
    const projects = make();
    projects.setWanted(PROJECT, ["jq"]);
    await projects.rebuild(PROJECT, false);
    projects.setWanted(PROJECT, ["jq", "make"]);
    fake.handle("image.build", () => {
      throw new Error("apt failed");
    });
    await expect(projects.rebuild(PROJECT, true)).rejects.toThrow();
    expect(projects.packages(PROJECT)).toEqual({ built: ["jq"], wanted: ["jq", "make"] });
    expect(warnings).toEqual(["project_image_build_failed"]);
  });

  it("what was built survives a restart of the daemon", async () => {
    const projects = make();
    projects.setWanted(PROJECT, ["jq"]);
    await projects.rebuild(PROJECT, false);
    expect(make().packages(PROJECT)).toEqual({ built: ["jq"], wanted: ["jq"] });
    projects.forget(PROJECT);
    expect(make().packages(PROJECT)).toEqual({ built: [], wanted: null });
  });
});
