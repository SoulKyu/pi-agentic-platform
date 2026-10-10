import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ForkedHost, forkHost, type HostRecord } from "./fork-host.ts";

export const RULES = { profile: "interactive", approvalMode: "auto-accept-edits" } as const;

export interface LaunchOptions {
  /** The `policy` field of the init record. */
  policy?: unknown;
  /** Written to `<agentDir>/settings.json` before the worker starts. */
  settings?: object;
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
export const isConfirm = (record: HostRecord) =>
  record.type === "extension_ui_request" && record.method === "confirm";

/** A temporary world for one forked worker: every path it may touch lives under `root`, never under the real home. */
export function createHostBed() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pap-host-")));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const papHome = join(root, "pap");
  const home = join(root, "home");
  for (const dir of [agentDir, cwd, papHome, home]) mkdirSync(dir);
  let current: ForkedHost | undefined;

  function launch(script: object, options: LaunchOptions = {}): ForkedHost {
    const scriptPath = join(root, "script.json");
    writeFileSync(scriptPath, JSON.stringify(script));
    if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      HOME: home,
      PI_CODING_AGENT_DIR: options.agentDirEnv ?? agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      PAP_TEST_PROVIDER: "1",
      ...options.env,
    };
    current = forkHost(env, cwd);
    current.send({
      type: "init",
      cwd,
      agentDir,
      papHome,
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
      const stderr = current?.stderr() ?? "";
      current?.kill();
      await current?.exited;
      current = undefined;
      rmSync(root, { recursive: true, force: true });
      // A connection the guard refused may have been swallowed by the code that tried it: the log still says so (R94).
      const blocked = stderr.split("\n").filter((line) => line.startsWith("pap-network-guard: blocked"));
      if (blocked.length > 0)
        throw new Error(`the worker tried to reach the network:\n${blocked.join("\n")}`);
    },
  };
}
