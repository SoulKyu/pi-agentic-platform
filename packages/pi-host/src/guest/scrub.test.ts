import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { takeGatewayToken } from "./scrub.ts";

const TOKEN = "ab".repeat(32);
let run: string;
beforeEach(() => {
  run = mkdtempSync(join(tmpdir(), "pap-scrub-"));
});
afterEach(() => rmSync(run, { recursive: true, force: true }));

interface Call {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}
function deps(env: NodeJS.ProcessEnv, calls: Call[] = []) {
  return {
    env,
    runDir: run,
    execPath: "/usr/bin/node",
    execArgv: ["--disable-warning=ExperimentalWarning"],
    argv: ["/usr/bin/node", "/opt/pap/guest/main.js", "extra"],
    execve: (file: string, args: readonly string[], next: NodeJS.ProcessEnv): void => {
      calls.push({ file, args, env: next });
    },
  };
}
const launch = (): string => join(run, "pap", "launch");

// Mutants of this file (RT-43), each killed by the case named after it:
//  - the token stays in the environment handed to execve            -> "re-executes without the token"
//  - the file is opened without O_EXCL                              -> "refuses a second scrub"
//  - the file is created with a wider mode                          -> "writes the token to a 0600 file"
//  - the read opens without O_NOFOLLOW / skips the mode check       -> "refuses a link / a readable file"
//  - the read does not unlink the file                              -> "reads the file once"
describe("takeGatewayToken", () => {
  it("writes the token to a 0600 file in a 0700 folder", () => {
    takeGatewayToken(deps({ PAP_GATEWAY_TOKEN: TOKEN }));
    expect(readFileSync(launch(), "utf8")).toBe(TOKEN);
    expect(statSync(launch()).mode & 0o777).toBe(0o600);
    expect(statSync(join(run, "pap")).mode & 0o777).toBe(0o700);
  });

  it("re-executes without the token, keeping the rest of the environment and the arguments", () => {
    const calls: Call[] = [];
    const given = { PAP_GATEWAY_TOKEN: TOKEN, PAP_GATEWAY: "10.213.0.1:7841", PATH: "/bin" };
    expect(takeGatewayToken(deps(given, calls))).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/node");
    expect(calls[0]?.args).toEqual([
      "/usr/bin/node",
      "--disable-warning=ExperimentalWarning",
      "/opt/pap/guest/main.js",
      "extra",
    ]);
    expect(calls[0]?.env).toEqual({ PAP_GATEWAY: "10.213.0.1:7841", PATH: "/bin" });
    expect(JSON.stringify(calls[0])).not.toContain(TOKEN);
    expect(given.PAP_GATEWAY_TOKEN).toBe(TOKEN);
  });

  it("refuses a second scrub while the file is there", () => {
    takeGatewayToken(deps({ PAP_GATEWAY_TOKEN: TOKEN }));
    const calls: Call[] = [];
    expect(() => takeGatewayToken(deps({ PAP_GATEWAY_TOKEN: "cd".repeat(32) }, calls))).toThrow(/EEXIST/);
    expect(calls).toHaveLength(0);
    expect(readFileSync(launch(), "utf8")).toBe(TOKEN);
  });

  it("refuses a link where the file goes", () => {
    mkdirSync(join(run, "pap"), { mode: 0o700 });
    writeFileSync(join(run, "victim"), "untouched");
    symlinkSync(join(run, "victim"), launch());
    expect(() => takeGatewayToken(deps({ PAP_GATEWAY_TOKEN: TOKEN }))).toThrow();
    expect(readFileSync(join(run, "victim"), "utf8")).toBe("untouched");
  });

  it("refuses a folder others can enter", () => {
    mkdirSync(join(run, "pap"), { mode: 0o755 });
    chmodSync(join(run, "pap"), 0o755);
    expect(() => takeGatewayToken(deps({ PAP_GATEWAY_TOKEN: TOKEN }))).toThrow(/private/);
    expect(existsSync(launch())).toBe(false);
  });

  it("removes the file when the re-execution fails", () => {
    const failing = {
      ...deps({ PAP_GATEWAY_TOKEN: TOKEN }),
      execve: (): void => {
        throw new Error("execve failed");
      },
    };
    expect(() => takeGatewayToken(failing)).toThrow(/execve failed/);
    expect(existsSync(launch())).toBe(false);
  });

  it("reads the file once, unlinks it and returns the token when the environment has none", () => {
    takeGatewayToken(deps({ PAP_GATEWAY_TOKEN: TOKEN }));
    const calls: Call[] = [];
    expect(takeGatewayToken(deps({}, calls))).toBe(TOKEN);
    expect(existsSync(launch())).toBe(false);
    expect(calls).toHaveLength(0);
    expect(() => takeGatewayToken(deps({}))).toThrow(/ENOENT/);
  });

  it("refuses a link, a readable file and a malformed token on the read side", () => {
    mkdirSync(join(run, "pap"), { mode: 0o700 });
    writeFileSync(join(run, "victim"), TOKEN, { mode: 0o600 });
    symlinkSync(join(run, "victim"), launch());
    expect(() => takeGatewayToken(deps({}))).toThrow();
    rmSync(launch(), { force: true });
    writeFileSync(launch(), TOKEN, { mode: 0o644 });
    chmodSync(launch(), 0o644);
    expect(() => takeGatewayToken(deps({}))).toThrow(/private/);
    rmSync(launch(), { force: true });
    writeFileSync(launch(), "not a token", { mode: 0o600 });
    expect(() => takeGatewayToken(deps({}))).toThrow(/malformed/);
    expect(existsSync(launch())).toBe(false);
  });

  it("does not put the token in an error message", () => {
    mkdirSync(join(run, "pap"), { mode: 0o700 });
    writeFileSync(launch(), TOKEN + "x", { mode: 0o600 });
    let message = "";
    try {
      takeGatewayToken(deps({}));
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(TOKEN);
  });
});
