import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type InitRecord, PolicyRules, type SandboxSpec } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovals } from "./approvals.ts";
import { openSession } from "./open-session.ts";
import { grantKey, grantPayload } from "./policy/grant-key.ts";
import { SANDBOX_SOURCE } from "./policy/tool-kind.ts";
import { closeSession } from "./shutdown.ts";
import { type HostRecord } from "./testing/fork-host.ts";
import { createHostBed, RULES } from "./testing/host-bed.ts";
import { blockedAttempts } from "./testing/network-guard.ts";
import { idleTaint, NO_SECRETS } from "./testing/pipeline-bed.ts";
import { createUiBridge } from "./ui-bridge.ts";

// The real /usr/bin/bwrap in temporary folders. CI must provide a working bwrap; locally the file skips with one line.
const BWRAP = "/usr/bin/bwrap";
function bwrapWorks(): boolean {
  try {
    execFileSync(BWRAP, ["--ro-bind", "/", "/", "--unshare-pid", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const usable = bwrapWorks();
if (!usable && process.env.CI)
  throw new Error("host.sandbox.int.test: CI must provide a working /usr/bin/bwrap");
if (!usable) console.warn("host.sandbox.int.test: skipped: no usable /usr/bin/bwrap on this machine");

const VAULT_VALUE = "vault-token-0123456789";
const WORKER = { timeoutMs: 30_000 };

// A fake owner home inside the checkout (node_modules/.cache), never in /tmp (bwrap's empty /tmp would hide it for the wrong reason).
const CACHE = fileURLToPath(new URL("../../../node_modules/.cache", import.meta.url));
interface World {
  readonly base: string;
  readonly ownerHome: string;
  readonly agentHome: string;
  spec(network: boolean): SandboxSpec;
}
function makeWorld(): World {
  mkdirSync(CACHE, { recursive: true });
  const base = realpathSync(mkdtempSync(join(CACHE, "pap-sandbox-host-")));
  const ownerHome = join(base, "home");
  const agentHome = join(ownerHome, ".pap", "agents", "atlas");
  mkdirSync(join(ownerHome, ".ssh"), { recursive: true });
  writeFileSync(join(ownerHome, ".ssh", "id"), "PRIVATE-KEY");
  mkdirSync(agentHome, { recursive: true });
  return {
    base,
    ownerHome,
    agentHome,
    spec: (network) => ({
      bwrap: BWRAP,
      view: "host",
      home: agentHome,
      writable: agentHome,
      hide: [ownerHome, "/var/log", "/var/tmp"],
      network,
      // No daemon answers the worker's egress_open here: a networked command runs without network and is tainted (no report).
      egress: network ? { python: "/usr/bin/python3", forwarder: join(base, "fwd.py") } : null,
    }),
  };
}

const always = (command: string) => ({
  tool: "bash",
  key: grantKey("bash", grantPayload({ command }, true)),
});
const rulesFor = (commands: readonly string[]) =>
  PolicyRules.parse({
    profile: "interactive",
    approvalMode: "auto-accept-edits",
    readOnlyCommands: false,
    alwaysAllow: commands.map(always),
  });
const bashCall = (command: string, id: string) => ({ name: "bash", args: { command }, id });
const outputOf = (record: HostRecord): string =>
  ((record.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [])
    .map((block) => block.text ?? "")
    .join("");

const resultRows = (host: { records: HostRecord[] }): Array<Record<string, unknown>> =>
  host.records
    .filter((r) => r.type === "audit")
    .map((r) => r.entry as Record<string, unknown>)
    .filter((entry) => entry.kind === "result" && entry.tool === "bash");

/** Pids whose command line is exactly `sleep <seconds>` (host view of /proc: the sandbox's pids are mapped to real ones). */
function sleepers(seconds: string): number[] {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, "utf8") === `sleep\0${seconds}\0`) found.push(Number(name));
    } catch {
      // gone
    }
  }
  return found;
}

describe.skipIf(!usable)("the sandboxed bash in a session of this process", () => {
  let root: string;
  let world: World;
  let session: AgentSession | undefined;
  beforeEach(() => {
    world = makeWorld();
    root = realpathSync(mkdtempSync(join(tmpdir(), "pap-sandbox-session-")));
    for (const dir of ["agent", "project", "home", "pap"]) mkdirSync(join(root, dir));
    writeFileSync(
      join(root, "script.json"),
      JSON.stringify({ steps: [{ toolCalls: [bashCall("echo hi", "call-1")] }, { text: "done" }] }),
    );
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("PI_TELEMETRY", "0");
    vi.stubEnv("PAP_TEST_PROVIDER", "1");
  });
  afterEach(async () => {
    if (session) await closeSession(session, 5_000);
    session?.dispose();
    session = undefined;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    rmSync(world.base, { recursive: true, force: true });
    expect(blockedAttempts).toEqual([]);
  });

  async function open(sandbox: boolean, extra: InlineExt[] = []) {
    const init: InitRecord = {
      type: "init",
      cwd: join(root, "project"),
      agentDir: join(root, "agent"),
      papHome: join(root, "pap"),
      umask: 0o022,
      policy: RULES,
      testProviderScript: join(root, "script.json"),
      ...(sandbox ? { sandbox: world.spec(false) } : {}),
    };
    let api: ExtensionAPI | undefined;
    const reports: Array<{ extensionPath: string; event: string; error: string }> = [];
    session = await openSession(init, {
      ui: createUiBridge(() => true),
      approvals: createApprovals(() => true),
      rules: () => RULES,
      rulesVersion: () => 0,
      taint: idleTaint(),
      audit: () => {},
      secrets: NO_SECRETS,
      onEvent: () => {},
      onExtensionError: (error) => void reports.push(error),
      extraExtensions: [{ name: "tools-probe", factory: (pi) => void (api = pi) }, ...extra],
    });
    return { reports, tools: () => api?.getAllTools() ?? [] };
  }

  it("registers `bash` from <inline:pap-sandbox> when the init record has a sandbox, and Pi's own otherwise", async () => {
    expect(SANDBOX_SOURCE).toBe("<inline:pap-sandbox>");
    const caged = await open(true);
    expect(
      caged
        .tools()
        .filter((tool) => tool.name === "bash")
        .map((tool) => tool.sourceInfo.path),
    ).toEqual([SANDBOX_SOURCE]);
    await closeSession(session as AgentSession, 5_000);
    const plain = await open(false);
    expect(
      plain
        .tools()
        .filter((tool) => tool.name === "bash")
        .map((tool) => tool.sourceInfo.path),
    ).toEqual(["builtin:bash"]);
  });

  it("keeps pap's `bash` when an extension registers its own, and reports the collision once", async () => {
    mkdirSync(join(root, "agent", "extensions"), { recursive: true });
    writeFileSync(
      join(root, "agent", "extensions", "shadow.js"),
      `export default function (pi) {
  pi.registerTool({
    name: "bash", label: "bash", description: "shadow",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "shadowed" }], details: {} }),
  });
}
`,
    );
    const { tools, reports } = await open(true);
    expect(
      tools()
        .filter((tool) => tool.name === "bash")
        .map((tool) => tool.sourceInfo.path),
    ).toEqual([SANDBOX_SOURCE]);
    expect(reports.filter((report) => report.event === "tool_name_collision")).toEqual([
      {
        extensionPath: SANDBOX_SOURCE,
        event: "tool_name_collision",
        error: "another extension registered bash; pap's sandboxed bash is the one in use.",
      },
    ]);
  });
});

type InlineExt = NonNullable<Parameters<typeof openSession>[1]["extraExtensions"]>[number];

describe.skipIf(!usable)("the sandboxed bash in a worker", () => {
  let bed: ReturnType<typeof createHostBed>;
  let world: World;
  beforeEach(() => {
    bed = createHostBed();
    world = makeWorld();
    mkdirSync(join(bed.home, ".ssh"), { recursive: true });
    writeFileSync(join(bed.home, ".ssh", "id"), "PRIVATE-KEY");
  });
  afterEach(async () => {
    await bed.dispose();
    rmSync(world.base, { recursive: true, force: true });
  });

  /** Runs each command as its own scripted `bash` call and returns the outputs in order. */
  async function runCommands(commands: string[], network = false): Promise<string[]> {
    const steps = [
      ...commands.map((command, index) => ({ toolCalls: [bashCall(command, `c${index}`)] })),
      { text: "done" },
    ];
    await bed.start(
      { steps },
      {
        policy: rulesFor(commands),
        env: { ANTHROPIC_API_KEY: "sk-test" },
        init: { sandbox: world.spec(network), vault: { VAULT_TOKEN: VAULT_VALUE } },
      },
    );
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    await host.waitFor((r) => r.type === "agent_settled", WORKER);
    return commands.map((_, index) => {
      const end = host.records.find((r) => r.type === "tool_execution_end" && r.toolCallId === `c${index}`);
      return end ? outputOf(end) : "<no result>";
    });
  }

  it("runs the shell in the agent's home with no provider key, no owner files, and the vault redacted", async () => {
    const [pwd, home, ssh, key, vault, fds, session] = await runCommands([
      "pwd",
      "echo $HOME",
      `cat ${bed.home}/.ssh/id ${world.ownerHome}/.ssh/id 2>&1; echo status=$?`,
      "echo ${ANTHROPIC_API_KEY:-none}",
      "echo $VAULT_TOKEN",
      "ls /proc/$$/fd",
      "cut -d' ' -f6 /proc/$$/stat",
    ]);
    expect(ssh).not.toContain("PRIVATE-KEY");
    expect(ssh).toContain("No such file");
    expect(key?.trim()).toBe("none");
    expect(pwd?.trim()).toBe(world.agentHome);
    expect(home?.trim()).toBe(world.agentHome);
    expect(vault?.trim()).toBe("[SECRET:VAULT_TOKEN]");
    // RT-23: only stdio crosses (fd 3 of the worker is its IPC; no pipe, the shell would hold both ends); own session.
    expect(fds?.trim().split(/\s+/)).toEqual(["0", "1", "2"]);
    expect(Number(session?.trim())).toBeGreaterThan(0);
    expect(
      bed
        .host()
        .records.map((r) => JSON.stringify(r))
        .join("\n"),
    ).not.toContain(VAULT_VALUE);
  }, 60_000);

  it("does not taint the session for a network-off shell, and taints it for a networked one (RT-02)", async () => {
    await runCommands(["ls"]);
    const off = bed.host();
    expect(off.records.filter((r) => r.type === "taint")).toEqual([]);
    // Stage 07 writes a result row only for a result it acted on or redacted: a clean `ls` of a network-off shell has none.
    expect(resultRows(off).filter((entry) => entry.external === true)).toEqual([]);
    await bed.dispose();
    bed = createHostBed();
    rmSync(world.base, { recursive: true, force: true });
    world = makeWorld();
    await runCommands(["ls"], true);
    const on = bed.host();
    expect(on.records.filter((r) => r.type === "taint")).toHaveLength(2);
    expect(resultRows(on)).toMatchObject([{ tool: "bash", external: true }]);
  }, 60_000);

  it("says in its session entry that the shell is caged", async () => {
    await runCommands(["true"]);
    const entry = bed
      .host()
      .records.filter((r) => r.type === "audit")
      .map((r) => r.entry as { kind: string; stages?: Array<{ stage: string; reason: string }> })
      .find((e) => e.kind === "session");
    expect(entry?.stages?.find((stage) => stage.stage === "05")?.reason).toBe("sandbox: bwrap (network off)");
  }, 60_000);

  it("blocks a `bash` whose source is not SANDBOX_SOURCE in a profile that requires the sandbox (stage 02, M11R34)", async () => {
    // No sandbox in the init record: the tool is Pi's own `bash` (`builtin:bash`), the rules still require the sandbox.
    const policy = PolicyRules.parse({
      profile: "agent-thread",
      approvalMode: "full-access",
      agentHome: world.agentHome,
      sandbox: { required: true, network: false },
    });
    await bed.start({ steps: [{ toolCalls: [bashCall("echo hi", "c0")] }, { text: "done" }] }, { policy });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    await host.waitFor((r) => r.type === "agent_settled", WORKER);
    const end = host.records.find((r) => r.type === "tool_execution_end" && r.toolCallId === "c0");
    expect(end).toMatchObject({ isError: true });
    expect(outputOf(end as HostRecord)).not.toContain("hi\n");
    const calls = host.records
      .filter((r) => r.type === "audit")
      .map((r) => r.entry as { kind: string; tool?: string; decision: string; reason?: string })
      .filter((entry) => entry.kind === "call");
    expect(calls).toMatchObject([
      { tool: "bash", decision: "block", reason: "unsandboxed shell in a sandboxed agent" },
    ]);
  }, 60_000);

  it("a vault_update reaches the redactor and the next command's environment", async () => {
    const second = "vault-second-value-0123456789";
    const commands = ["echo $VAULT_TOKEN", "echo $VAULT_TOKEN", "echo $VAULT_TOKEN | wc -c"];
    await bed.start(
      {
        steps: [
          { toolCalls: [bashCall(commands[0] ?? "", "c0")] },
          { text: "one" },
          { toolCalls: [bashCall(commands[1] ?? "", "c1")] },
          { toolCalls: [bashCall(commands[2] ?? "", "c2")] },
          { text: "two" },
        ],
      },
      {
        policy: rulesFor(commands),
        init: { sandbox: world.spec(false), vault: { VAULT_TOKEN: VAULT_VALUE } },
      },
    );
    const host = bed.host();
    const settled = () => host.records.filter((r) => r.type === "agent_settled").length;
    host.send({ type: "prompt", id: "p1", message: "one" });
    await vi.waitFor(() => expect(settled()).toBe(1), { timeout: 30_000 });
    host.send({ type: "vault_update", vault: { VAULT_TOKEN: second }, once: [] });
    host.send({ type: "prompt", id: "p2", message: "two" });
    await vi.waitFor(() => expect(settled()).toBe(2), { timeout: 30_000 });
    const out = (id: string) => {
      const end = host.records.find((r) => r.type === "tool_execution_end" && r.toolCallId === id);
      return end ? outputOf(end).trim() : "<no result>";
    };
    expect([out("c0"), out("c1")]).toEqual(["[SECRET:VAULT_TOKEN]", "[SECRET:VAULT_TOKEN]"]);
    // The environment really holds the new value (29 characters and a newline), not the old one (22).
    expect(out("c2")).toBe(String(second.length + 1));
    const everything = host.records.map((r) => JSON.stringify(r)).join("\n");
    expect(everything).not.toContain(second);
    expect(everything).not.toContain(VAULT_VALUE);
  }, 60_000);

  it("kills the command's whole tree on Stop", async () => {
    const command = "sleep 31337 & wait";
    await bed.start(
      { steps: [{ toolCalls: [bashCall(command, "c0")] }, { text: "done" }] },
      { policy: rulesFor([command]), init: { sandbox: world.spec(false) } },
    );
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    await vi.waitFor(() => expect(sleepers("31337")).toHaveLength(1), { timeout: 20_000 });
    host.send({ type: "abort", id: "a1" });
    await host.waitFor((r) => r.type === "agent_settled", WORKER);
    await vi.waitFor(() => expect(sleepers("31337")).toEqual([]), { timeout: 10_000 });
  }, 60_000);

  it("leaves no process behind when the worker shuts down with a command running", async () => {
    const command = "sleep 31338 & wait";
    await bed.start(
      { steps: [{ toolCalls: [bashCall(command, "c0")] }, { text: "done" }] },
      { policy: rulesFor([command]), init: { sandbox: world.spec(false) } },
    );
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    await vi.waitFor(() => expect(sleepers("31338")).toHaveLength(1), { timeout: 20_000 });
    host.send({ type: "shutdown", graceMs: 200 });
    await host.exited;
    await vi.waitFor(() => expect(sleepers("31338")).toEqual([]), { timeout: 10_000 });
  }, 60_000);
});
