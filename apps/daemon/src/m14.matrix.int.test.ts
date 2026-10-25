import { collectClientPaths, memberDenied, type MethodName, methods } from "@pap/contracts";
import { rows } from "./security/testing/automation-bed.ts";
import { writeScript } from "./security/testing/agent-bed.ts";
import { markOf, waitIdle } from "./security/testing/fixtures.ts";
import { rawCall, rawStep } from "./security/testing/raw-platform-extension.ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ALL_CLASSIFIED,
  FORBIDDEN,
  METHOD_CLASS,
  NO_FOREIGN_INPUT,
  type Probe,
  PROBES,
  ROUTE_CLASS,
  SHARED_READ,
} from "./testing/m14-classes.ts";
import { CANARY, codeOf, startTwoUsers, type TwoUsers } from "./testing/two-users.ts";

// M14 J1: every method and route is classified, and a member never reads or changes the owner's rows through any of them.
// The owner owns one row of each kind (a session, a project with a file, a trigger and its task, an agent, an Inbox item, a
// terminal, a token, a device), every one holding a canary; the member owns none and calls everything with the owner's ids.

let u: TwoUsers;
let host: string;
let mine: { sessionId: string };
let before: string;
const stateOf = async (): Promise<string> => {
  const trigger = await u.owner.call("automation.triggers.get", { triggerId: u.seeds.triggerId });
  const agent = await u.owner.call("agents.get", { agentId: u.seeds.agentId });
  const pick = (frame: { ok: boolean; result?: unknown }, keys: string[]) =>
    keys.map((key) => (frame.result as Record<string, unknown>)[key]);
  return JSON.stringify([
    pick(trigger as never, ["enabled", "name", "revision", "prompt"]),
    pick(agent as never, ["paused", "name", "revision", "quarantinedAt"]),
  ]);
};
beforeAll(async () => {
  u = await startTwoUsers();
  host = u.bed.t.cwd;
  before = await stateOf();
  // The member's own project and session: the shared-read answers are asked about something that is theirs.
  const created = await u.member.call("projects.create", { name: "Mine" });
  const project = (created.ok ? created.result : null) as { project: { id: string; root: string } };
  await u.member.call("projects.startBox", { projectId: project.project.id });
  const opened = await u.member.call("sessions.create", { cwd: project.project.root });
  mine = { sessionId: (opened.ok ? opened.result : null) as unknown as string } as never;
  mine = opened.ok ? (opened.result as { sessionId: string }) : mine;
}, 180_000);
afterAll(async () => u?.stop());

const call = (method: string, params: object) => u.member.call(method as MethodName, params as never);
const PROBE_ENTRIES = Object.entries(PROBES) as Array<[string, Probe]>;

describe("the classification", () => {
  it("every method is in exactly one list, and the forbidden ones are exactly the denied permissions", () => {
    const lists = [
      FORBIDDEN as readonly string[],
      Object.keys(SHARED_READ),
      Object.keys(NO_FOREIGN_INPUT),
      Object.keys(PROBES),
    ];
    for (const name of Object.keys(methods)) {
      expect(lists.filter((list) => list.includes(name)).length, name).toBe(1);
      expect(METHOD_CLASS[name as MethodName], name).toBeDefined();
    }
    // Compile time: a method in no list is a type error on ALL_CLASSIFIED; this is its runtime echo.
    expect(ALL_CLASSIFIED).toBe(true);
    expect(lists.flat().filter((name) => !(name in methods))).toEqual([]);
    const denied = Object.entries(methods)
      .filter(([, def]) => memberDenied(def.permission))
      .map(([name]) => name)
      .sort();
    expect([...FORBIDDEN].sort()).toEqual(denied);
  });

  it("every HTTP route is classified, and a classified route exists", () => {
    const served = [...new Set(u.bed.t.daemon.inspect.routes())];
    const known = new Set(Object.keys(ROUTE_CLASS));
    const middleware = new Set(["ALL /*", "ALL /auth/*", "ALL /fonts", "ALL /fonts/*", "ALL /github/*"]);
    expect(served.filter((route) => !known.has(route) && !middleware.has(route))).toEqual([]);
    expect([...known].filter((route) => !served.includes(route))).toEqual([]);
  });
});

describe("a member against the owner's rows", () => {
  it("member-forbidden: one call with {} answers forbidden before the params parse", async () => {
    const wrong: string[] = [];
    for (const name of FORBIDDEN) {
      const code = codeOf(await call(name, {}));
      if (code !== "forbidden") wrong.push(`${name} -> ${code}`);
    }
    expect(wrong).toEqual([]);
  });

  it("shared-read: the answer has exactly its keys and none of the owner's", async () => {
    const wrong: string[] = [];
    for (const [name, keys] of Object.entries(SHARED_READ)) {
      const bound = name === "sessions.commands" || name === "subagents.profiles";
      const frame = await call(name, bound ? { sessionId: mine.sessionId } : {});
      if (!frame.ok) wrong.push(`${name} -> ${frame.error.code}`);
      else if (
        Object.keys(frame.result as object)
          .sort()
          .join() !== [...keys].sort().join()
      )
        wrong.push(
          `${name} keys ${Object.keys(frame.result as object)
            .sort()
            .join()}`,
        );
    }
    expect(wrong).toEqual([]);
    // Asked about the owner's session, the two session-bound ones say not_found and give no profile or command.
    for (const name of ["sessions.commands", "subagents.profiles"])
      expect(codeOf(await call(name, { sessionId: u.seeds.sessionId })), name).toBe("not_found");
  });

  it("member-own without a foreign input: answers about the member's own state", async () => {
    const wrong: string[] = [];
    for (const [name, params] of Object.entries(NO_FOREIGN_INPUT)) {
      const code = codeOf(await call(name, params));
      if (["internal", "unknown_method", "bad_request", "forbidden"].includes(code))
        wrong.push(`${name} -> ${code}`);
    }
    expect(wrong).toEqual([]);
  });

  it("member-own with the owner's ids: not_found or forbidden, an empty answer only where declared", async () => {
    const wrong: string[] = [];
    for (const [name, probe] of PROBE_ENTRIES) {
      const frame = await call(name, probe.params(u.seeds));
      const code = codeOf(frame);
      const fine =
        code === "not_found" ||
        code === "forbidden" ||
        code === probe.also ||
        (probe.empty === true && code === "ok");
      if (!fine) wrong.push(`${name} -> ${code}${frame.ok ? "" : ` ${JSON.stringify(frame.error)}`}`);
    }
    expect(wrong).toEqual([]);
  });

  it("a host path in any ClientPath field is forbidden for a member, before the handler", async () => {
    const swap = (value: unknown): unknown => {
      if (typeof value === "string")
        return value.startsWith(u.seeds.project.root)
          ? `${host}${value.slice(u.seeds.project.root.length)}`
          : value;
      if (Array.isArray(value)) return value.map(swap);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, swap(inner)]));
      return value;
    };
    const tried = new Set<string>();
    const wrong: string[] = [];
    for (const [name, probe] of PROBE_ENTRIES) {
      const params = swap(probe.params(u.seeds));
      const { paths } = collectClientPaths(() => methods[name as MethodName].params.safeParse(params));
      if (paths.length === 0) continue;
      tried.add(name);
      const code = codeOf(await call(name, params as object));
      if (code !== "forbidden") wrong.push(`${name} -> ${code}`);
    }
    expect(wrong).toEqual([]);
    // Every member-allowed method with a path-like top-level field was exercised.
    const pathLike = Object.entries(methods)
      .filter(([, def]) => !memberDenied(def.permission))
      .filter(([, def]) => {
        const shape = z.toJSONSchema(def.params, { io: "input", unrepresentable: "any" }).properties ?? {};
        return ["path", "cwd", "root", "projectRoot"].some((key) => key in shape);
      })
      .map(([name]) => name)
      // An agent's file is named inside the agent's own folder, never by a host path.
      .filter((name) => !tried.has(name) && name !== "agents.files.remove");
    expect(pathLike).toEqual([]);
  });

  it("while the member is subscribed, the owner's live work (a prompt, a run, an Inbox item, a failure) reaches the member as nothing", async () => {
    const { owner, seeds, member } = u;
    const seen = member.client.events.length;
    // An agent notifies the owner (an Inbox item and a card), a task fails (an Inbox item, a failure), a session runs.
    writeScript(u.bed.t, {
      steps: [
        rawStep([rawCall("agent.notify", "n1", { text: `${CANARY.inbox} live note` })]),
        { text: "ok" },
      ],
    });
    const thread = await owner.call("agents.openThread", { agentId: seeds.agentId });
    const threadId = (thread.ok ? thread.result : { sessionId: "" }) as { sessionId: string };
    await owner.call("subscribe.session", { sessionId: threadId.sessionId });
    const mark = markOf(owner.client);
    await owner.call("sessions.prompt", { sessionId: threadId.sessionId, text: "tell me something" });
    await waitIdle(owner.client, mark);
    writeScript(u.bed.t, { steps: [{ stopReason: "error", errorMessage: "boom failure" }] });
    await owner.call("automation.fire", { triggerId: seeds.triggerId });
    await vi.waitFor(
      () => {
        const states = rows<{ state: string }>(
          u.bed.t.home,
          "SELECT state FROM tasks WHERE trigger_id = ?",
          seeds.triggerId,
        );
        expect(states.some((task) => ["failed", "done", "interrupted"].includes(task.state))).toBe(true);
      },
      { timeout: 30_000 },
    );
    writeScript(u.bed.t, { steps: Array.from({ length: 6 }, () => ({ text: "ok" })) });
    await owner.call("sessions.prompt", { sessionId: seeds.sessionId, text: "live work" });
    await vi.waitFor(
      () =>
        expect(
          rows<{ n: number }>(
            u.bed.t.home,
            "SELECT count(*) AS n FROM runs WHERE session_id = ?",
            seeds.sessionId,
          )[0]?.n,
        ).toBeGreaterThan(0),
      { timeout: 30_000 },
    );
    // The owner's side did happen: the Inbox holds the notification.
    const inbox = JSON.stringify(await owner.call("inbox.list", {}));
    expect(inbox).toContain(CANARY.inbox);
    // The member's streams stayed up, were fed (their own snapshots at least), and carry none of it.
    const frames = JSON.stringify(member.client.events.slice(0));
    expect(member.client.events.length).toBeGreaterThan(0);
    expect(member.client.events.length).toBeGreaterThanOrEqual(seen);
    for (const secret of [
      ...Object.values(CANARY),
      owner.id,
      seeds.sessionId,
      seeds.project.id,
      seeds.agentId,
      seeds.triggerId,
      seeds.taskId,
      "boom failure",
      "live work",
      "tell me something",
    ])
      expect(frames, secret).not.toContain(secret);
  }, 120_000);

  it("the owner's rows are unchanged and the member received none of them", async () => {
    const { owner, seeds } = u;
    const sessions = JSON.stringify(await owner.call("sessions.list", {}));
    expect(sessions).toContain(CANARY.session);
    const read = await owner.call("files.read", { path: seeds.filePath });
    expect(read.ok && (read.result as { text: string }).text).toBe(CANARY.file);
    expect(await stateOf()).toBe(before);
    const attached = await owner.call("terminal.attach", { terminalId: seeds.terminalId });
    expect(attached.ok).toBe(true);
    const inbox = await owner.call("inbox.list", {});
    const item = (
      inbox.ok ? (inbox.result as { items: Array<{ id: string; readAt?: number | null }> }).items : []
    ).find((entry) => entry.id === seeds.inboxId);
    expect(item).toBeDefined();
    expect(item?.readAt ?? null).toBeNull();
    const projects = JSON.stringify(await owner.call("projects.box", { projectId: seeds.project.id }));
    expect(projects).toContain('"ok":true');
    const tokens = (await owner.call("auth.tokens.list", {})).ok;
    expect(tokens).toBe(true);
    expect(JSON.stringify(await owner.call("auth.tokens.list", {}))).toContain(seeds.tokenId);
    expect(JSON.stringify(await owner.call("auth.devices.list", {}))).toContain(seeds.deviceId);
    const received = u.received();
    for (const canary of Object.values(CANARY)) expect(received, canary).not.toContain(canary);
    expect(received).not.toContain(owner.id);
    expect(received).not.toContain(seeds.sessionId);
    expect(received).not.toContain(seeds.project.id);
    expect(received).not.toContain(seeds.agentId);
  });
});
