import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { type ForkedHost, forkHost, type HostRecord } from "./fork-host.ts";

export const RULES = PolicyRules.parse({
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  alwaysAllow: [],
  // These tests drive the approval channel with `echo`, a read-only command; host.read-only.int.test.ts covers the switch on.
  readOnlyCommands: false,
});

export interface LaunchOptions {
  /** The `policy` field of the init record. */
  policy?: unknown;
  /** Written to `<agentDir>/settings.json` before the worker starts. */
  settings?: object;
  /** Files written under the agent directory before the worker starts, by relative path (`mcp.json`, `extensions/x.js`). */
  agentFiles?: Readonly<Record<string, string>>;
  /** Replaces PI_CODING_AGENT_DIR in the worker environment. */
  agentDirEnv?: string;
  /** Extra fields of the init record. */
  init?: Record<string, unknown>;
  /** Worker environment entries added to (or, set to undefined, removed from) the defaults. */
  env?: Record<string, string | undefined>;
}

export const bashScript = (command: string) => ({
  steps: [{ toolCalls: [{ name: "bash", args: { command }, id: "call-1" }] }, { text: "done" }],
});
export const toolScript = (name: string, args: Record<string, string | number | boolean>) => ({
  steps: [{ toolCalls: [{ name, args, id: "call-1" }] }, { text: "done" }],
});
export const textOf = (message: unknown) =>
  ((message as { content?: Array<{ type: string; text?: string }> }).content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
export const toolText = (record: HostRecord) => JSON.stringify(record.result);
export const isApproval = (record: HostRecord) => record.type === "approval_request";
export const isCallAudit = (record: HostRecord) =>
  record.type === "audit" && (record.entry as { kind?: unknown } | undefined)?.kind === "call";

/** Something outside the worker's group could hold its output open; the bed does not wait for that for ever. */
const CLOSE_WAIT_MS = 5000;
const within = (promise: Promise<unknown>, ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/** A temporary world for forked workers: every path they may touch lives under `root`, never under the real home. */
export function createHostBed(fork: typeof forkHost = forkHost) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pap-host-")));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const papHome = join(root, "pap");
  const home = join(root, "home");
  for (const dir of [agentDir, cwd, papHome, home]) mkdirSync(dir);
  // Every worker the bed launched, not just the last: a test may start several, and each one's log is checked.
  const launched: ForkedHost[] = [];
  let current: ForkedHost | undefined;

  function launch(script: object, options: LaunchOptions = {}): ForkedHost {
    const scriptPath = join(root, "script.json");
    writeFileSync(scriptPath, JSON.stringify(script));
    for (const [file, content] of Object.entries(options.agentFiles ?? {})) {
      const target = join(agentDir, file);
      if (file.split(/[\\/]/).includes("..") || relative(agentDir, target).startsWith(".."))
        throw new Error(`agent file outside the agent directory: ${file}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
    for (const key of Object.keys(options.env ?? {})) {
      if (key === "HOME" || key.startsWith("PI_"))
        throw new Error(`env cannot set ${key}: it isolates the worker`);
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      PAP_TEST_PROVIDER: "1",
      ...options.env,
      HOME: home,
      PI_CODING_AGENT_DIR: options.agentDirEnv ?? agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    };
    current = fork(env, cwd);
    launched.push(current);
    current.send({
      type: "init",
      cwd,
      agentDir,
      papHome,
      umask: 0o022,
      policy: "policy" in options ? options.policy : RULES,
      testProviderScript: scriptPath,
      ...options.init,
    });
    return current;
  }

  return {
    root,
    agentDir,
    cwd,
    papHome,
    home,
    launch,
    async start(script: object, options: LaunchOptions = {}): Promise<HostRecord> {
      return launch(script, options).waitFor((record) => record.type === "ready");
    },
    host(): ForkedHost {
      if (!current) throw new Error("host not started");
      return current;
    },
    async dispose(): Promise<void> {
      const hosts = launched.splice(0);
      current = undefined;
      for (const host of hosts) host.kill();
      await Promise.all(hosts.map((host) => host.exited));
      // The exit can be reported before the last of the output has been read: it is complete when the pipes close.
      await Promise.all(hosts.map((host) => within(host.closed, CLOSE_WAIT_MS)));
      rmSync(root, { recursive: true, force: true });
      // A connection the guard refused may have been swallowed by the code that tried it: the log still says so (R94).
      const blocked = hosts
        .flatMap((host) => host.stderr().split("\n"))
        .filter((line) => line.startsWith("pap-network-guard: blocked"));
      if (blocked.length > 0) throw new Error(`a worker tried to reach the network:\n${blocked.join("\n")}`);
    },
  };
}
