import type { ProjectView } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callOf } from "./security/testing/agent-bed.ts";
import { markOf, waitIdle } from "./security/testing/fixtures.ts";
import { freePort } from "./testing/free-port.ts";
import { declare, previewPortOf, projectBox, through } from "./testing/preview-bed.ts";
import { addMember, codeOf, type Person, startTwoUsers, type TwoUsers } from "./testing/two-users.ts";

// UX-2 T10 for members: a member works on their own boxes as the owner does on theirs and never reaches another user's, an API
// token never mints, and a disabled or deleted account's pages stop (UX2-R32, R72).

const REPLY = "```html\n<p>member page</p>\n```\n";
let u: TwoUsers;
let previewPort: number;
beforeAll(async () => {
  u = await startTwoUsers(
    { steps: [{ text: REPLY }, ...Array.from({ length: 11 }, () => ({ text: "ok" }))] },
    { config: { agentsMemoryMaxMb: 65_536, maxWorkers: 32 } },
  );
  previewPort = await previewPortOf(u.bed.t);
}, 180_000);
afterAll(async () => u?.stop());

interface Held {
  readonly project: ProjectView;
  readonly service: string;
  readonly lease: string;
  readonly artifact: string;
}

/** A project box of `who` with a running preview, an open lease and an HTML artifact of their own transcript. */
async function hold(who: Person, name: string): Promise<Held> {
  const call = callOf(who.client);
  const { project } = await call<{ project: ProjectView }>("projects.create", { name });
  await call("projects.startBox", { projectId: project.id });
  await call("previews.startProject", { projectId: project.id, ...declare(project, await freePort()) });
  const opened = await call<{ url: string; lease: string }>("previews.open", {
    box: projectBox(project.id),
    name: "project",
  });
  const { sessionId } = await call<{ sessionId: string }>("sessions.create", { cwd: project.root });
  // Seq spaces are per subscription: the mark and the wait name theirs.
  const live = await call<{ sub: string }>("subscribe.session", { sessionId });
  const mark = markOf(who.client, live.sub);
  await call("sessions.prompt", { sessionId, text: "draw" });
  await waitIdle(who.client, mark, live.sub);
  const { sub } = await call<{ sub: string }>("subscribe.session", { sessionId });
  const snapshot = await who.client.waitForEvent((frame) => frame.sub === sub);
  const rows = (snapshot.event as { rows: Array<{ entryId: string | null; message: { role?: string } }> })
    .rows;
  const entryId = rows.find((row) => row.message.role === "assistant")?.entryId ?? "";
  const artifact = await call<{ url: string }>("previews.artifact", { sessionId, entryId, fenceIndex: 0 });
  return { project, service: opened.url, lease: opened.lease, artifact: artifact.url };
}
const status = async (url: string): Promise<number> => (await through(previewPort, url)).status;

describe("previews for members", () => {
  it("a member opens a preview of their own box and gets not_found for the owner's", async () => {
    const mine = await hold(u.member, "Mine");
    expect(await status(mine.service)).toBe(200);
    expect(await status(mine.artifact)).toBe(200);
    // The owner runs a preview of their own box too: the member learns nothing of it, whatever they call.
    const owners = projectBox(u.seeds.project.id);
    const owner = callOf(u.owner.client);
    await owner("previews.startProject", {
      projectId: u.seeds.project.id,
      ...declare(u.seeds.project, await freePort()),
    });
    const foreign = [
      await u.member.call("previews.list", { box: owners }),
      await u.member.call("previews.open", { box: owners, name: "project" }),
      await u.member.call("previews.stop", { box: owners, name: "project" }),
      await u.member.call("previews.restart", { box: owners, name: "project" }),
      await u.member.call("previews.logs", { box: owners, name: "project" }),
      await u.member.call("previews.artifact", {
        sessionId: u.seeds.sessionId,
        entryId: "e1",
        fenceIndex: 0,
      }),
    ];
    expect(foreign.map(codeOf)).toEqual(Array(foreign.length).fill("not_found"));
    expect(u.received()).not.toContain(u.seeds.project.id);
    // And the owner's own call about the same box is theirs.
    expect(codeOf(await u.owner.call("previews.list", { box: owners }))).toBe("ok");
  });

  it("a token caller is forbidden on open, renew, close and artifact", async () => {
    const owner = await u.bed.t.connectBearer(u.owner.token);
    const member = await u.bed.t.connectBearer(u.member.token);
    try {
      for (const [client, box] of [
        [owner, projectBox(u.seeds.project.id)],
        [member, projectBox((await hold(u.member, "Tokens")).project.id)],
      ] as const) {
        const lease = "ab".repeat(16);
        const answers = [
          await client.call("previews.open", { box, name: "project" }),
          await client.call("previews.renew", { lease }),
          await client.call("previews.close", { lease }),
          await client.call("previews.artifact", {
            sessionId: u.seeds.sessionId,
            entryId: "e1",
            fenceIndex: 0,
          }),
        ];
        expect(answers.map(codeOf)).toEqual(["forbidden", "forbidden", "forbidden", "forbidden"]);
        // The reads and the stop stay open to a token with the permission.
        expect(codeOf(await client.call("previews.list", { box }))).toBe("ok");
      }
    } finally {
      owner.close();
      member.close();
    }
  });

  it("deleting a member revokes their tokens", async () => {
    const dan = await addMember(u.bed, "dan");
    const held = await hold(dan, "Dans");
    expect(await status(held.service)).toBe(200);
    expect(await status(held.artifact)).toBe(200);
    await u.bed.t.confirmStepUp(u.owner.cookie);
    expect(codeOf(await u.owner.call("users.delete", { userId: dan.id }))).toBe("ok");
    expect(await status(held.service)).toBe(404);
    // An artifact token does not depend on the box: only the revocation of the account's tokens ends it.
    expect(await status(held.artifact)).toBe(404);
  });

  it("disabling a member revokes their tokens", async () => {
    const held = await hold(u.member, "Mine too");
    expect(await status(held.service)).toBe(200);
    expect(await status(held.artifact)).toBe(200);
    await u.bed.t.confirmStepUp(u.owner.cookie);
    expect(codeOf(await u.owner.call("users.setDisabled", { userId: u.member.id, disabled: true }))).toBe(
      "ok",
    );
    expect(await status(held.service)).toBe(404);
    expect(await status(held.artifact)).toBe(404);
  });
});
