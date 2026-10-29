import { describe, expect, it } from "vitest";
import { bwrapVmArgv } from "../../vm-shell/argv.ts";
import { shellFixedEnv } from "../../vm-shell/ops.ts";
import { encodeSeccomp, shellSeccompProgram } from "../../vm-shell/seccomp.ts";
import { layout } from "../../testing/guest-harness.ts";
import { GUEST_BWRAP, SERVICE_SECCOMP_FD, serviceLaunch } from "./launch.ts";

const PROXY = { HTTP_PROXY: "http://10.213.0.1:7843", PATH: "/evil", HOME: "/evil", PORT: "1" };
const input = { layout, command: "python3 -m http.server 8000", port: 8000, proxy: PROXY };

/** The slot is random per launch; every other word of the command line is the shell's own. */
const withoutSlot = (argv: readonly string[]): string[] =>
  argv.map((word) => word.replace(/[0-9a-f]{32}/, "SLOT"));

describe("serviceLaunch", () => {
  it("is the shell's own bwrap command line, network off", () => {
    const { argv } = serviceLaunch({ ...input, network: false });
    const shell = bwrapVmArgv(
      { bwrap: GUEST_BWRAP, layout, slot: "0".repeat(32), rootView: "read-only", network: false },
      input.command,
      SERVICE_SECCOMP_FD,
    );
    expect(withoutSlot(argv)).toEqual(withoutSlot(shell));
    expect(argv).toContain("--unshare-net");
    expect(argv).toContain("--die-with-parent");
    expect(argv.slice(-3)).toEqual(["/bin/sh", "-c", input.command]);
    expect(argv[0]).toBe("/usr/bin/bwrap");
    expect(SERVICE_SECCOMP_FD).toBe(3);
  });

  it("keeps the VM's network only when the session's shell has it, with the proxy variables", () => {
    const on = serviceLaunch({ ...input, network: true });
    expect(on.argv).not.toContain("--unshare-net");
    expect(on.env).toEqual({
      HTTP_PROXY: "http://10.213.0.1:7843",
      ...shellFixedEnv(layout),
      PORT: "8000",
    });
    const off = serviceLaunch({ ...input, network: false });
    expect(Object.keys(off.env).sort()).toEqual(["HOME", "LANG", "PATH", "PORT", "TERM"]);
  });

  it("carries the shell's seccomp program and the fixed names over anything the proxy says", () => {
    const launch = serviceLaunch({ ...input, network: true });
    expect(launch.filter.equals(encodeSeccomp(shellSeccompProgram()))).toBe(true);
    expect(launch.env.PATH).toBe(shellFixedEnv(layout).PATH);
    expect(launch.env.HOME).toBe(layout.home);
    expect(launch.env.PORT).toBe("8000");
  });
});
