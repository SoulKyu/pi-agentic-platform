import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpRequest } from "./testing/http-client.ts";
import { CANARY, startTwoUsers, type TwoUsers } from "./testing/two-users.ts";

// M14 J1, the Hono routes: a member's cookie or token on every route that names a path, a session, an agent or a trigger of
// the owner. Each answer is a refusal, none holds a canary, and the owner's file, token and export are still theirs.

let u: TwoUsers;
beforeAll(async () => void (u = await startTwoUsers()), 180_000);
afterAll(async () => u?.stop());

const q = (value: string) => encodeURIComponent(value);
/** A refusal for the right reason: the member is signed in and the row or the right is not theirs. */
const refused = (status: number) => [403, 404].includes(status);
const bearer = () => ({ origin: u.bed.t.origin, authorization: `Bearer ${u.member.token}` });
const raw = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) =>
  httpRequest(`${u.bed.t.base}${path}`, init);

describe("the file routes", () => {
  it("GET /files/raw: the owner's file and a host path are refused to a member, by cookie and by token", async () => {
    const replies = [
      await u.member.http(`/files/raw?path=${q(u.seeds.filePath)}`),
      await u.member.http(`/files/raw?path=${q(u.bed.t.cwd)}`),
      await raw(`/files/raw?path=${q(u.seeds.filePath)}`, { headers: bearer() }),
      await raw(`/files/raw?path=${q(u.seeds.filePath)}`, { headers: { origin: u.bed.t.origin } }),
    ];
    for (const reply of replies) expect(reply.body).not.toContain(CANARY.file);
    for (const reply of replies.slice(0, 2))
      expect(refused(reply.status), `${reply.status} ${reply.body}`).toBe(true);
    // These routes know the browser's cookie only: a bearer token, a member's or any, is unauthenticated.
    expect([replies[2]?.status, replies[3]?.status]).toEqual([401, 401]);
    const owner = await u.owner.http(`/files/raw?path=${q(u.seeds.filePath)}`);
    expect(owner.status).toBe(200);
    expect(owner.body).toBe(CANARY.file);
  });

  it("PUT /files/raw and POST /upload: a member writes nothing under the owner's project or session", async () => {
    const put = await u.member.http(`/files/raw?path=${q(u.seeds.filePath)}&conflict=replace`, {
      method: "PUT",
      headers: { "content-length": "11" },
      body: "overwritten",
    });
    const putHost = await u.member.http(`/files/raw?path=${q(`${u.bed.t.cwd}/x.txt`)}&conflict=replace`, {
      method: "PUT",
      headers: { "content-length": "10" },
      body: "host write",
    });
    const upload = await u.member.http(`/upload?name=x.txt&sessionId=${q(u.seeds.sessionId)}`, {
      method: "POST",
      headers: { "content-length": "8" },
      body: "attached",
    });
    for (const reply of [put, putHost]) expect(refused(reply.status), reply.body).toBe(true);
    // An upload only stages a file under the uploader's own name: the owner's session cannot claim it.
    expect(upload.status).toBe(201);
    const staged = (JSON.parse(upload.body) as { id: string }).id;
    const claimed = await u.owner.call("sessions.prompt", {
      sessionId: u.seeds.sessionId,
      text: "use it",
      attachments: [staged],
    });
    expect(claimed.ok).toBe(false);
    const read = await u.owner.call("files.read", { path: u.seeds.filePath });
    expect(read.ok && (read.result as { text: string }).text).toBe(CANARY.file);
    expect(() => readFileSync(`${u.bed.t.cwd}/x.txt`)).toThrow();
  });

  it("PUT /agent-files: a member cannot put a file in the owner's agent", async () => {
    const reply = await u.member.http(`/agent-files?agentId=${q(u.seeds.agentId)}&path=notes.md`, {
      method: "PUT",
      headers: { "content-length": "4" },
      body: "take",
    });
    expect(refused(reply.status), reply.body).toBe(true);
    const listed = await u.owner.call("agents.files.list", { agentId: u.seeds.agentId });
    expect(JSON.stringify(listed)).not.toContain("notes.md");
  });
});

describe("the other routes", () => {
  it("an export link is the owner's alone: a member's try leaves it valid for the owner", async () => {
    // A box session has no HTML export (the VM has no host file to patch): the owner's own host session does.
    const hostSession = await u.bed.openSession(u.bed.t.cwd);
    await u.bed.prompt(hostSession, "say something to export");
    const made = await u.owner.call("sessions.exportHtml", { sessionId: hostSession });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const url = new URL(
      (made.ok ? (made.result as { url: string }) : { url: "http://x/" }).url,
      u.bed.t.base,
    );
    const stolen = await u.member.http(url.pathname);
    expect(refused(stolen.status), `${stolen.status}`).toBe(true);
    expect(stolen.body).not.toContain(CANARY.session);
    const mine = await u.owner.http(url.pathname);
    expect(mine.status).toBe(200);
  });

  it("a hook of the owner's trigger answers a member nothing: the secret is the only way in", async () => {
    const reply = await u.member.http(`/hooks/${q(u.seeds.triggerId)}`, { method: "POST", body: "{}" });
    expect(refused(reply.status) || reply.status === 405, `${reply.status}`).toBe(true);
    expect(reply.body).not.toContain(CANARY.trigger);
  });

  it("the GitHub routes: creating the App is the owner's", async () => {
    const create = await u.member.http("/github/app/new?state=" + "0".repeat(32));
    expect([400, 403, 404]).toContain(create.status);
    const finish = await u.member.http(`/github/app/authorized/finish?ticket=${"0".repeat(32)}`);
    expect([400, 403, 404]).toContain(finish.status);
    for (const reply of [create, finish]) expect(reply.body).not.toContain(u.owner.id);
  });

  it("a member's token cannot write or upload to the owner's rows, and the callbacks and fonts give nothing of the owner's", async () => {
    const put = await raw(`/files/raw?path=${q(u.seeds.filePath)}&conflict=replace`, {
      method: "PUT",
      headers: { ...bearer(), "content-length": "4" },
      body: "take",
    });
    const upload = await raw(`/upload?name=x.txt&sessionId=${q(u.seeds.sessionId)}`, {
      method: "POST",
      headers: { ...bearer(), "content-length": "4" },
      body: "take",
    });
    const agentFile = await raw(`/agent-files?agentId=${q(u.seeds.agentId)}&path=a.md`, {
      method: "PUT",
      headers: { ...bearer(), "content-length": "4" },
      body: "take",
    });
    for (const reply of [put, upload, agentFile]) expect(reply.status, reply.body).toBe(401);
    // The App's callbacks need the state they issued (no cookie, no state: nothing), and fonts are the install's.
    for (const path of ["/github/app/created", "/github/app/authorized", "/fonts/none/none.woff2"]) {
      const reply = await u.member.http(path);
      expect(reply.status, path).toBeLessThan(500);
      expect(reply.body, path).not.toContain(u.owner.id);
    }
    const read = await u.owner.call("files.read", { path: u.seeds.filePath });
    expect(read.ok && (read.result as { text: string }).text).toBe(CANARY.file);
  });

  it("every route needs a session where it names the caller's rows: no cookie, no answer", async () => {
    const bare = { origin: u.bed.t.origin };
    for (const [method, path] of [
      ["GET", `/files/raw?path=${q(u.seeds.filePath)}`],
      ["PUT", `/files/raw?path=${q(u.seeds.filePath)}&conflict=replace`],
      ["POST", `/upload?name=x&sessionId=${q(u.seeds.sessionId)}`],
      ["PUT", `/agent-files?agentId=${q(u.seeds.agentId)}&path=a.md`],
      ["GET", `/api/sessions/${q(u.seeds.sessionId)}/export/${"a".repeat(43)}`],
    ] as const) {
      const reply = await raw(path, { method, headers: bare, body: method === "GET" ? undefined : "x" });
      expect(reply.status, `${method} ${path}`).toBe(401);
    }
  });
});
