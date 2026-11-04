import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentsVm } from "./compose-agents-vm.ts";
import { callOf, reopenOwner } from "./security/testing/agent-bed.ts";
import { openOwner } from "./security/testing/automation-bed.ts";
import { httpRequest } from "./testing/http-client.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import { vmPlumbing, type VmPlumbing } from "./testing/vm-plumbing.ts";
import type { TestClient } from "./testing/ws-client.ts";

// Always-on boxes (decision 149) through a real daemon on the process backend: the boxes start with pap, the agent's VM
// comes back after it is killed, a disabled member's agent stays stopped, and turning the switch off lets the VM go.
// The daemon runs with a low worker idle time, so the last case waits seconds, not half an hour.
const IDLE_MS = 2_000;
const MEMBER_PASSWORD = "member horse battery staple";
const root = mkdtempSync(join(tmpdir(), "pap-always-on-"));
let t: TestDaemon;
let plumbing: VmPlumbing;
let client: TestClient;
let call: ReturnType<typeof callOf>;

afterAll(async () => {
  await stopLife();
  rmSync(root, { recursive: true, force: true });
});

async function stopLife(): Promise<void> {
  client?.close();
  if (t === undefined) return;
  // The VM's copy of the image is read-only: the folder must be writable again to go.
  execFileSync("chmod", ["-R", "u+w", root]);
  try {
    await t.stop();
  } finally {
    plumbing.dispose();
  }
}

/** One life of the daemon on the same folders. */
async function life(first = false): Promise<void> {
  await stopLife();
  plumbing = vmPlumbing({ config: { workerIdleMs: IDLE_MS } });
  t = await startTestDaemon({ steps: [{ text: "ok" }] }, { root, ...plumbing.options });
  client = first ? (await openOwner(t)).client : (await reopenOwner(t)).client;
  call = callOf(client);
}

const vm = (): AgentsVm => {
  const exposed = plumbing.exposed();
  if (exposed === undefined) throw new Error("the VM composition was not exposed");
  return exposed;
};
const phaseOf = (kind: "agent" | "project", id: string) => vm().runtime.phase({ kind, id });
const profile = (name: string, alwaysOn: boolean) =>
  AgentInput.parse({ name, preset: "read-only", sandbox: { required: false }, alwaysOn });
const untilPhase = (kind: "agent" | "project", id: string, phase: string) =>
  vi.waitFor(() => expect(phaseOf(kind, id)).toBe(phase), { timeout: 30_000, interval: 50 });

/** Kills the agent's guest process group, as a crashed VM would go. */
function killGuestOf(agentId: string): void {
  const script = `PAP_TEST_PROVIDER_SCRIPT=${join(root, "script.json")}`;
  const hits = readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        return env.includes(`PAP_BOX=agent:${agentId}`) && env.includes(script);
      } catch {
        return false;
      }
    })
    .map(Number);
  expect(hits.length).toBeGreaterThan(0);
  for (const pid of hits) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // not a group leader (ESRCH): its leader's group kill takes it down
    }
  }
}

/** Invites a member as the owner and returns a socket of theirs. */
async function addMember(name: string): Promise<{ id: string; client: TestClient }> {
  const invited = await call<{ url: string }>("users.invite", { nameHint: name });
  const token = new URL(invited.url).hash.replace("#token=", "");
  const accepted = await httpRequest(`${t.base}/auth/invite/accept`, {
    method: "POST",
    headers: { origin: t.origin, "content-type": "application/json" },
    body: JSON.stringify({ token, username: name, password: MEMBER_PASSWORD }),
  });
  const header = accepted.headers["set-cookie"];
  const cookie = ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
  await httpRequest(`${t.base}/auth/confirm`, {
    method: "POST",
    headers: { origin: t.origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ password: MEMBER_PASSWORD }),
  });
  const listed = await call<{ users: Array<{ id: string; username: string }> }>("users.list", {});
  const id = listed.users.find((user) => user.username === name)?.id ?? "";
  return { id, client: await t.connect(cookie) };
}

const ids = { always: "", plain: "", member: "", boxOn: "", boxOff: "" };

describe("always-on boxes", () => {
  it("sets the switch on boxes that stay stopped until pap restarts (R8)", async () => {
    await life(true);
    ids.always = (await call<{ id: string }>("agents.create", { input: profile("Always", true) })).id;
    ids.plain = (await call<{ id: string }>("agents.create", { input: profile("Plain", false) })).id;
    const mia = await addMember("mia");
    ids.member = (
      await callOf(mia.client)<{ id: string }>("agents.create", { input: profile("Mine", true) })
    ).id;
    mia.client.close();
    ids.boxOn = (await call<{ project: { id: string } }>("projects.create", { name: "on" })).project.id;
    ids.boxOff = (await call<{ project: { id: string } }>("projects.create", { name: "off" })).project.id;
    await call("projects.setBox", { projectId: ids.boxOn, alwaysOn: true });
    await call("users.setDisabled", { userId: await memberId(), disabled: true });
    expect(phaseOf("agent", ids.always)).toBe("stopped");
    expect(phaseOf("project", ids.boxOn)).toBe("stopped");
  });

  it("starts the always-on agent and project at boot, and no other box", async () => {
    await life();
    await untilPhase("agent", ids.always, "running");
    await untilPhase("project", ids.boxOn, "running");
    expect(phaseOf("agent", ids.plain)).toBe("stopped");
    expect(phaseOf("project", ids.boxOff)).toBe("stopped");
    expect(phaseOf("agent", ids.member)).toBe("stopped");
  });

  it("starts the agent's VM again after it is killed", async () => {
    const before = plumbing.vms.started.filter((spec) => spec.box.id === ids.always).length;
    killGuestOf(ids.always);
    await vi.waitFor(
      () =>
        expect(plumbing.vms.started.filter((spec) => spec.box.id === ids.always)).toHaveLength(before + 1),
      { timeout: 30_000, interval: 50 },
    );
    await untilPhase("agent", ids.always, "running");
  });

  it("lets the VM go, one idle time after the switch is turned off", async () => {
    const view = await call<{ revision: number }>("agents.get", { agentId: ids.always });
    await call("agents.update", {
      agentId: ids.always,
      baseRevision: view.revision,
      input: profile("Always", false),
    });
    await untilPhase("agent", ids.always, "stopped");
    expect(phaseOf("project", ids.boxOn)).toBe("running");
  });

  async function memberId(): Promise<string> {
    const listed = await call<{ users: Array<{ id: string; role: string }> }>("users.list", {});
    return listed.users.find((user) => user.role === "member")?.id ?? "";
  }
});
