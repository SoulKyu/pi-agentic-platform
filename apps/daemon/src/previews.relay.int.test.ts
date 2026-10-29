import type { PreviewView, ProjectView } from "@pap/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactCsp } from "./kernel/http/preview/csp.ts";
import { rows } from "./security/testing/automation-bed.ts";
import { markOf, waitIdle } from "./security/testing/fixtures.ts";
import { createSteppableClock, type SteppableClock } from "./security/testing/steppable-clock.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import { freePort } from "./testing/free-port.ts";
import { bodyOf, declare, previewPortOf, projectBox, registryOf, through } from "./testing/preview-bed.ts";

// UX-2 T10 through the real daemon on the process backend: the real preview listener on port 0, a real tunnel to a service that
// runs as a local process in the box's guest, and the owner's own RPCs. Every request goes through the listener as a frame would.

const REPLY = "intro\n```html\n<p>one</p>\n```\n```js\nlet x\n```\n```html\n<p>two</p>\n```\n";
const DEFAULT_STEPS = Array.from({ length: 6 }, () => ({ text: "ok" }));
let clock: SteppableClock;
let bed: BoxBed;
let project: ProjectView;
let decl: { command: string; port: number };
let previewPort: number;
const box = () => projectBox(project.id);

beforeAll(async () => {
  clock = createSteppableClock();
  bed = await startBoxBed({ steps: [{ text: REPLY }, ...DEFAULT_STEPS] }, { deps: { clock } });
  project = await bed.createProject("Site");
  await bed.startBox(project.id);
  decl = declare(project, await freePort());
  previewPort = await previewPortOf(bed.t);
}, 180_000);
afterAll(async () => bed?.stop());

const serve = () =>
  bed.call<{ service: PreviewView }>("previews.startProject", { projectId: project.id, ...decl });
const open = () =>
  bed.call<{ url: string; lease: string; leaseMs: number }>("previews.open", { box: box(), name: "project" });
const get = (url: string, path = "", headers: Record<string, string> = {}) =>
  through(previewPort, url, path, headers);
beforeEach(async () => {
  await serve();
}, 60_000);

describe("previews.open and the relay", () => {
  it("previews.open answers a URL on the preview origin, and a GET through it reaches the service", async () => {
    const opened = await open();
    expect(opened.url).toMatch(new RegExp(`^http://localhost:${previewPort}/p/[A-Za-z0-9_-]{43}/$`));
    expect(opened.leaseMs).toBe(300_000);
    const reply = await get(opened.url, "page?x=1");
    expect(reply.status).toBe(200);
    const seen = bodyOf(reply);
    expect(seen.url).toBe("/page?x=1");
    expect(seen.prefix).toBe(new URL(opened.url).pathname.replace(/\/$/, ""));
    expect(String(reply.headers["content-security-policy"])).toMatch(/^sandbox allow-scripts /);
  });

  it("the service never sees the cookie the browser sent, and the browser never gets its Set-Cookie", async () => {
    const opened = await open();
    const reply = await get(opened.url, "", { cookie: "pap_session=SECRET", authorization: "Bearer SECRET" });
    expect(reply.status).toBe(200);
    expect(bodyOf(reply).cookie).toBeNull();
    expect(reply.headers["set-cookie"]).toBeUndefined();
    expect(reply.body).not.toContain("SECRET");
  });

  it("previews.close revokes the token: the next GET through it is 404", async () => {
    const opened = await open();
    expect((await get(opened.url)).status).toBe(200);
    await bed.call("previews.close", { lease: opened.lease });
    expect((await get(opened.url)).status).toBe(404);
    // An unknown lease and a second close answer the same, silently.
    await bed.call("previews.close", { lease: opened.lease });
    await bed.call("previews.close", { lease: "00".repeat(16) });
  });

  it("a token of a stopped service answers 404", async () => {
    const opened = await open();
    expect((await get(opened.url)).status).toBe(200);
    await bed.call("previews.stop", { box: box(), name: "project" });
    expect((await get(opened.url)).status).toBe(404);
    const reopened = await bed.owner.client.call("previews.open", { box: box(), name: "project" });
    expect(reopened.ok ? "ok" : reopened.error.code).toBe("not_found");
  });

  it("a restart under a new service id kills the old token", async () => {
    const opened = await open();
    await serve();
    expect((await get(opened.url)).status).toBe(404);
    expect((await get((await open()).url)).status).toBe(200);
  });

  it("previews.renew keeps the token alive past 5 minutes; without it the token dies", async () => {
    const opened = await open();
    await clock.advance(4 * 60_000);
    const before = clock.now();
    const renewed = await bed.call<{ until: number }>("previews.renew", { lease: opened.lease });
    const after = clock.now();
    // The lease runs 5 minutes from the renewal, on the daemon's (steppable) clock.
    expect(renewed.until).toBeGreaterThanOrEqual(before + 300_000);
    expect(renewed.until).toBeLessThanOrEqual(after + 300_000);
    await clock.advance(2 * 60_000);
    expect((await get(opened.url)).status).toBe(200);
    await clock.advance(6 * 60_000);
    expect((await get(opened.url)).status).toBe(404);
    const late = await bed.owner.client.call("previews.renew", { lease: opened.lease });
    expect(late.ok ? "ok" : late.error.code).toBe("not_found");
  });

  it("a replayed previews.open command id answers conflict and the receipts table holds no URL", async () => {
    const params = { box: box(), name: "project" };
    const first = await bed.owner.client.call("previews.open", params, 30_000, "replay-open-1");
    expect(first.ok).toBe(true);
    const url = first.ok ? (first.result as { url: string }).url : "";
    const again = await bed.owner.client.call("previews.open", params, 30_000, "replay-open-1");
    expect(again.ok ? "ok" : again.error.code).toBe("conflict");
    const stored = rows<{ result: string }>(
      bed.t.home,
      "SELECT result FROM receipts WHERE method = 'previews.open' AND command_id = 'replay-open-1'",
    );
    expect(stored).toHaveLength(1);
    for (const row of stored) {
      expect(row.result).not.toContain("/p/");
      expect(row.result).not.toContain(url.split("/")[4] ?? "no-token");
      expect(JSON.parse(row.result)).toMatchObject({ secret: true });
    }
  });
});

describe("START PREVIEW of the project file", () => {
  it("previews.startProject starts the service project from .pi/project.yaml and refuses bad_request without one", async () => {
    const started = await serve();
    expect(started.service).toMatchObject({
      name: "project",
      port: decl.port,
      state: "running",
      network: true,
    });
    const bare = await bed.createProject("Bare");
    await bed.startBox(bare.id);
    const refused = await bed.owner.client.call("previews.startProject", {
      projectId: bare.id,
      command: decl.command,
      port: decl.port,
    });
    expect(refused.ok ? "ok" : refused.error.code).toBe("bad_request");
    expect(registryOf(bed.t).list(projectBox(bare.id))).toEqual([]);
  });

  it("a declaration changed after the page read it answers conflict and starts nothing", async () => {
    const other = await bed.createProject("Edited");
    await bed.startBox(other.id);
    const shown = declare(other, await freePort());
    // The file is edited between the page and the click (a cloned repository, the model): the command differs.
    declare(other, await freePort());
    const refused = await bed.owner.client.call("previews.startProject", { projectId: other.id, ...shown });
    expect(refused.ok ? "ok" : refused.error.code).toBe("conflict");
    expect(registryOf(bed.t).list(projectBox(other.id))).toEqual([]);
    expect(
      (await bed.call<{ services: unknown[] }>("previews.list", { box: projectBox(other.id) })).services,
    ).toEqual([]);
  });
});

describe("previews.artifact", () => {
  it("serves the fence the daemon read, by entry and index, and not_found for a non-html fence", async () => {
    const sessionId = await bed.openSession(project.root);
    const mark = markOf(bed.owner.client);
    await bed.call("sessions.prompt", { sessionId, text: "draw two pages" });
    await waitIdle(bed.owner.client, mark);
    const subscribed = await bed.call<{ sub: string }>("subscribe.session", { sessionId });
    const snapshot = await bed.owner.client.waitForEvent((frame) => frame.sub === subscribed.sub);
    const transcript = (
      snapshot.event as { rows: Array<{ entryId: string | null; message: { role?: string } }> }
    ).rows;
    const entryId = transcript.find((row) => row.message.role === "assistant")?.entryId ?? "";
    expect(entryId).not.toBe("");
    const mint = (fenceIndex: number, id = entryId) =>
      bed.owner.client.call("previews.artifact", { sessionId, entryId: id, fenceIndex });
    const first = await mint(0);
    const second = await mint(2);
    if (!first.ok || !second.ok) throw new Error("the artifacts were not minted");
    const one = await get((first.result as { url: string }).url);
    expect(one.status).toBe(200);
    expect(one.body).toBe("<p>one</p>");
    expect(String(one.headers["content-type"])).toContain("text/html");
    expect(one.headers["content-security-policy"]).toBe(artifactCsp([bed.t.origin, bed.t.base]));
    expect((await get((second.result as { url: string }).url)).body).toBe("<p>two</p>");
    for (const refused of [await mint(1), await mint(9), await mint(0, "no-such-entry")])
      expect(refused.ok ? "ok" : refused.error.code).toBe("not_found");
  });
});

describe("a box stop", () => {
  it("revokes every token of its services and empties previews.list", async () => {
    const opened = await open();
    expect((await get(opened.url)).status).toBe(200);
    await bed.vm.runtime.stop(box());
    await vi.waitFor(() => expect(registryOf(bed.t).list(box())).toEqual([]), { timeout: 15_000 });
    expect((await get(opened.url)).status).toBe(404);
    expect((await bed.call<{ services: unknown[] }>("previews.list", { box: box() })).services).toEqual([]);
    const gone = await bed.owner.client.call("previews.open", { box: box(), name: "project" });
    expect(gone.ok ? "ok" : gone.error.code).toBe("box_stopped");
  });
});
