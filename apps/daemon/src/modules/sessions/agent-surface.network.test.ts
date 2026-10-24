import type { Caller, PlatformOp } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProjectBoxRow } from "../../kernel/boxes.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { AUTOMATION_CREDENTIAL } from "./automation-port.ts";
import { createAgentSurface } from "./agent-surface.ts";
import type { ApprovedAnswer } from "./dialogs.ts";
import type { SessionRow } from "./store.ts";

const P1 = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
const P2 = "7a2d3f1f-9a6c-4c64-8b63-1e3a5b5d8e22";
const HOST = "api.example.com";

const row = (id: string, cwd: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  id,
  piPath: null,
  piSessionId: null,
  cwd,
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const rows = new Map<string, SessionRow>([
  ["s1", row("s1", `/boxes/${P1}/project`)],
  ["s2", row("s2", `/boxes/${P2}/project`)],
  ["host", row("host", "/home/u/code")],
  ["thread", row("thread", "/home/u/agent", { agentId: "atlas-0001", agentRole: "thread" })],
]);
const boxRow = (hosts: readonly string[]): ProjectBoxRow => ({
  ownerId: "u1",
  root: "/boxes/x",
  resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
  hosts,
  deleting: false,
});
const owner: Caller = {
  userId: "u1",
  permissions: new Set(),
  kind: "session",
  credentialId: "c1",
  stepUpUntil: 0,
};
const answer = (host = HOST): ApprovedAnswer => ({
  answer: "host",
  scope: "exact" as never,
  grant: { tool: "network_request", key: "k", label: "l", host } as never,
});

function setup(lists: Record<string, readonly string[]> = {}) {
  const { logger, lines } = captureLogger();
  const addHost = vi.fn();
  const surface = createAgentSurface({
    store: { get: (id: string) => rows.get(id), readOnly: false } as never,
    policy: { sessionPolicy: () => ({ taint: { tainted: false }, toolAllowlist: null }) } as never,
    clock: {} as never,
    logger,
    worker: { papHome: "/pap", agentDir: "/pi" },
  });
  surface.setAgentPorts({
    platform: { available: () => true } as never,
    agents: {
      profileOf: () => null,
      boxes: {
        projectOf: (r) =>
          r.agentId !== undefined
            ? null
            : r.cwd === `/boxes/${P1}/project`
              ? P1
              : r.cwd === `/boxes/${P2}/project`
                ? P2
                : null,
        box: (id) => boxRow(lists[id] ?? []),
        claudeTokenSet: () => false,
        addHost,
      },
    },
  });
  return { surface, addHost, lines };
}

describe("a box session's allowed host (spec boxes, task A7)", () => {
  it("a box session's allowed host joins its project's list only", () => {
    const { surface, addHost, lines } = setup();
    surface.noted("s1", answer(), owner);
    expect(addHost).toHaveBeenCalledTimes(1);
    expect(addHost).toHaveBeenCalledWith(P1, HOST, { actor: "user", actorId: "u1" });
    expect(surface.hostGrants.has("s1", HOST)).toBe(true);
    expect(surface.hostGrants.has("s2", HOST)).toBe(false);
    expect(surface.projectBoxOfSession("s1")).toMatchObject({ projectId: P1 });
    expect(JSON.stringify(lines)).not.toContain(HOST);
    expect(lines.find((line) => line.msg === "project_host_added")?.host).toMatch(
      /^h:[0-9a-f]{12} \(len 15\)$/,
    );
  });

  it("a host already on the list is not an error and is not added twice", () => {
    const { surface, addHost } = setup({ [P1]: [HOST] });
    surface.noted("s1", answer(), owner);
    expect(addHost).not.toHaveBeenCalled();
    expect(surface.hostGrants.has("s1", HOST)).toBe(true);
  });

  it("refuses a full list and an entry the agents' rule refuses: nothing is added, no grant is kept", () => {
    const full = Array.from({ length: 256 }, (_, n) => `h${n}.example.com`);
    const { surface, addHost } = setup({ [P1]: full });
    surface.noted("s1", answer(), owner);
    surface.noted("s2", answer("bad host"), owner);
    expect(addHost).not.toHaveBeenCalled();
    expect(surface.hostGrants.has("s1", HOST)).toBe(false);
    expect(surface.hostGrants.has("s2", "bad host")).toBe(false);
  });

  it("adds nothing for a host session, a token or the automation credential (an unattended task is denied)", () => {
    const { surface, addHost } = setup();
    const dialogs = () => [
      { id: "d1", method: "approval", tool: "network_request", answers: ["deny", "host"] },
    ];
    const session = { dialogs } as never;
    surface.noted("host", answer(), owner);
    surface.noted("s1", answer(), { ...owner, kind: "token" });
    surface.noted("s1", answer(), { ...owner, credentialId: AUTOMATION_CREDENTIAL });
    expect(addHost).not.toHaveBeenCalled();
    expect(() => surface.guardAnswer(session, "d1", owner, { answer: "host" }, "host")).toThrow();
    expect(() =>
      surface.guardAnswer(
        session,
        "d1",
        { ...owner, credentialId: AUTOMATION_CREDENTIAL },
        { answer: "host" },
        "s1",
      ),
    ).toThrow();
    expect(() => surface.guardAnswer(session, "d1", owner, { answer: "host" }, "s1")).not.toThrow();
  });

  it("an agent thread's host stays a thread grant, never a project's", () => {
    const { surface, addHost } = setup();
    surface.noted("thread", answer(), owner);
    expect(addHost).not.toHaveBeenCalled();
    expect(surface.hostGrants.has("thread", HOST)).toBe(true);
  });

  it("registers network.request for a box session and an agent thread, never for a host session", () => {
    const { surface } = setup();
    const has = (id: string) =>
      surface.platformOps(rows.get(id) as SessionRow).includes("network.request" as PlatformOp);
    expect([has("s1"), has("host"), has("thread")]).toEqual([true, false, true]);
  });
});
