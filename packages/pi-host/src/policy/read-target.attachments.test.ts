import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { checkReadTarget } from "./read-target.ts";

// M8 final review I3, M7 rebase brief item 2: $PAP_HOME/attachments/pending is always asked, and so is another
// session's folder. The worker reads pending images itself, so the agent never needs them.
const OWN = "11111111-aaaa-4aaa-8aaa-111111111111";
const OTHER = "22222222-bbbb-4bbb-8bbb-222222222222";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let attachments: string;
beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
  await mkdir(join(bed.base, "home"), { recursive: true });
  attachments = join(bed.papHome, "attachments");
  for (const dir of ["pending", join(OWN, "a1"), join(OTHER, "b1")])
    await mkdir(join(attachments, dir), { recursive: true });
  await writeFile(join(attachments, "pending", "p1"), "x");
  await writeFile(join(attachments, OWN, "a1", "own.txt"), "x");
  await writeFile(join(attachments, OTHER, "b1", "other.txt"), "x");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

const check = (tool: string, input: unknown, sessionId: string | null = OWN) =>
  checkReadTarget(tool, input, {
    cwd: bed.cwd,
    papHome: bed.papHome,
    agentDir: bed.agentDir,
    sessionId: sessionId ?? undefined,
  });
const asks = { why: "protected path" };

describe("checkReadTarget: attachments", () => {
  it("lets a session read its own attachments, by every read tool", async () => {
    const own = join(attachments, OWN, "a1");
    expect(await check("read", { path: join(own, "own.txt") })).toBeUndefined();
    expect(await check("ls", { path: own })).toBeUndefined();
    expect(await check("grep", { pattern: "x", path: own })).toBeUndefined();
    expect(await check("find", { pattern: "*", path: join(attachments, OWN) })).toBeUndefined();
  });

  it("asks for another session's attachments, by every read tool", async () => {
    const other = join(attachments, OTHER, "b1");
    expect(await check("read", { path: join(other, "other.txt") })).toMatchObject(asks);
    expect(await check("ls", { path: other })).toMatchObject(asks);
    expect(await check("grep", { pattern: "x", path: other })).toMatchObject(asks);
    expect(await check("find", { pattern: "*", path: join(attachments, OTHER) })).toMatchObject(asks);
  });

  it("always asks for the pending folder, whatever the session", async () => {
    const file = join(attachments, "pending", "p1");
    expect(await check("read", { path: file })).toMatchObject(asks);
    expect(await check("ls", { path: join(attachments, "pending") })).toMatchObject(asks);
    expect(await check("read", { path: file }, OTHER)).toMatchObject(asks);
  });

  it("asks for a search rooted at the attachments folder, which would read the others", async () => {
    expect(await check("grep", { pattern: "x", path: attachments })).toMatchObject(asks);
    expect(await check("find", { pattern: "*", path: attachments })).toMatchObject(asks);
  });

  it("lists the folder itself: it holds names of sessions only", async () => {
    expect(await check("ls", { path: attachments })).toBeUndefined();
  });

  it("asks for every attachment of a session that does not know its own id (fail closed)", async () => {
    expect(await check("read", { path: join(attachments, OWN, "a1", "own.txt") }, null)).toMatchObject(asks);
  });

  it("does not take a malformed id for a folder name", async () => {
    const file = join(attachments, OTHER, "b1", "other.txt");
    expect(await check("read", { path: file }, "..")).toMatchObject(asks);
    expect(await check("read", { path: file }, `${OWN}/../${OTHER}`)).toMatchObject(asks);
  });

  it("follows a link inside the session's own folder to another session's file", async () => {
    await symlink(join(attachments, OTHER, "b1"), join(attachments, OWN, "link"));
    expect(await check("read", { path: join(attachments, OWN, "link", "other.txt") })).toMatchObject(asks);
  });

  it("follows a link from the project folder to the pending folder", async () => {
    await symlink(join(attachments, "pending"), join(bed.cwd, "pend"));
    expect(await check("read", { path: "pend/p1" })).toMatchObject(asks);
  });

  it("judges a path spelled with dot segments and a relative path from the folder", async () => {
    expect(
      await check("read", { path: join(attachments, OWN, "..", OTHER, "b1", "other.txt") }),
    ).toMatchObject(asks);
  });
});
