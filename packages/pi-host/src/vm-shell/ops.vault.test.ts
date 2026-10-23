import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createOnceSecrets, withOnceSecrets } from "../once-secrets.ts";
import { createShellEnvironment } from "../shell-env.ts";
import type { VmShellSpec } from "./argv.ts";
import { vmShell } from "./ops.ts";

const spec: VmShellSpec = {
  bwrap: "/usr/bin/bwrap",
  layout: {
    root: "/agent",
    home: "/agent/home",
    knowledge: "/agent/knowledge",
    inbox: "/agent/inbox",
    pi: "/agent/.pi",
    sessions: "/agent/.pi/sessions",
    piAgentDir: "/agent/.pi/agent",
    imageAgentDir: "/opt/pap/pi-agent",
    shellOverlay: "/nowhere/overlay",
  },
  slot: "0123456789abcdef0123456789abcdef",
  rootView: "read-only",
  network: false,
};
const NOW = 1_000;

function bed(vault: Record<string, string>, base: Record<string, string> = {}) {
  const envs: Array<Record<string, string>> = [];
  const spawn = ((_file: string, _argv: readonly string[], options: { env: Record<string, string> }) => {
    envs.push(options.env);
    const child = Object.assign(new EventEmitter(), {
      pid: 424_242 + envs.length,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdio: [null, null, null, new PassThrough()] as unknown[],
    });
    setImmediate(() => child.emit("close", 0, null));
    return child;
  }) as unknown as typeof nodeSpawn;
  const used = vi.fn();
  const once = createOnceSecrets({ used, now: () => NOW });
  const environment = withOnceSecrets(createShellEnvironment(base, vault), once);
  const ops = vmShell(spec, { spawn, environment });
  const run = (command: string) => ops.exec(command, "/", { onData: () => {} });
  return { run, envs, used, once, environment };
}

describe("the VM shell and the vault (ADR 0081)", () => {
  it("gives the VM shell the vault's values and a one-use value once", async () => {
    const { run, envs, used, once } = bed({ API_TOKEN: "v-12345678" });
    once.replace([{ id: "o".repeat(8), name: "NPM_TOKEN", value: "o-12345678", expiresAt: NOW + 60_000 }]);

    await run("echo hi");
    expect(envs[0]).toMatchObject({ API_TOKEN: "v-12345678" });
    expect(envs[0]).not.toHaveProperty("NPM_TOKEN");
    expect(used).not.toHaveBeenCalled();

    await run("curl -H $NPM_TOKEN x");
    expect(envs[1]).toMatchObject({ API_TOKEN: "v-12345678", NPM_TOKEN: "o-12345678" });
    expect(used).toHaveBeenCalledExactlyOnceWith({ name: "NPM_TOKEN", id: "o".repeat(8) });

    await run("curl -H $NPM_TOKEN x");
    expect(envs[2]).not.toHaveProperty("NPM_TOKEN");
    expect(used).toHaveBeenCalledOnce();
  });

  it("delivers a vault update at the next command and keeps PATH, HOME, LANG and TERM the shell's own", async () => {
    const { run, envs, environment } = bed({ OLD_NAME: "old-value-1" }, { PATH: "/evil/bin:/usr/bin" });
    await run("true");
    environment.setVault({ NEW_NAME: "new-value-2", PATH: "/evil", HOME: "/evil" });
    await run("true");
    expect(envs[0]).toMatchObject({ OLD_NAME: "old-value-1" });
    expect(envs[1]).toMatchObject({ NEW_NAME: "new-value-2" });
    expect(envs[1]).not.toHaveProperty("OLD_NAME");
    for (const env of envs) {
      expect(env.HOME).toBe("/agent/home");
      expect(env.PATH).not.toContain("evil");
      expect(env.TERM).toBe("dumb");
    }
  });

  it("never passes the worker's own credentials to the shell", async () => {
    const { run, envs } = bed({}, { PAP_RELAY_KEY: "k".repeat(64), ANTHROPIC_API_KEY: "sk-ant-0123456789" });
    await run("env");
    expect(JSON.stringify(envs[0])).not.toContain("k".repeat(64));
    expect(JSON.stringify(envs[0])).not.toContain("sk-ant-0123456789");
  });
});
