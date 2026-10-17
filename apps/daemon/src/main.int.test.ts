import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freePort } from "./testing/free-port.ts";
import { httpRequest } from "./testing/http-client.ts";
import { selfSignedCertificate } from "./testing/self-signed.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const mode = (path: string) => statSync(path).mode & 0o777;

interface Serve {
  readonly child: ChildProcess;
  readonly lines: Array<Record<string, unknown>>;
  stderr(): string;
  line(msg: string): Record<string, unknown> | undefined;
  exit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let root: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-main-"));
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

// The real entry point in a real process, in a throwaway home: never the user's ~/.pap or ~/.pi/agent.
function run(args: string[], home = join(root, "home"), env: Record<string, string> = {}): Serve {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--conditions=development", MAIN, ...args],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        HOME: join(root, "user"),
        PAP_HOME: home,
        PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_TELEMETRY: "0",
        PAP_WORKER_SCOPE: "off",
        ...env,
      },
    },
  );
  children.push(child);
  const lines: Array<Record<string, unknown>> = [];
  let err = "";
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      lines.push(JSON.parse(pending.slice(0, at)) as Record<string, unknown>);
      pending = pending.slice(at + 1);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    lines,
    stderr: () => err,
    line: (msg) => lines.find((line) => line.msg === msg),
    exit: () => closed,
  };
}

describe("pap serve", () => {
  it("boots, prints the setup address and where it listens, and stops cleanly on SIGTERM", async () => {
    const port = await freePort();
    const serve = run(["serve", "--port", String(port)]);
    // `setup_url` is printed by main after the daemon returns, a tick after `listening` (which the daemon logs itself).
    await vi.waitFor(
      () => {
        expect(serve.line("listening")).toBeDefined();
        expect(serve.line("setup_url")).toBeDefined();
      },
      { timeout: 20_000 },
    );
    expect(serve.line("listening")).toMatchObject({ url: `http://localhost:${port}`, port });
    expect(serve.lines.filter((line) => line.msg === "setup_url")).toHaveLength(1);
    expect(String(serve.line("setup_url")?.url)).toMatch(
      new RegExp(`^http://localhost:${port}/setup#token=[\\w-]{20,}$`),
    );
    expect((await httpRequest(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const home = join(root, "home");
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, "state.db"))).toBe(0o600);
    expect(existsSync(join(home, "pap.lock"))).toBe(true);

    serve.child.kill("SIGTERM");
    expect(await serve.exit()).toEqual({ code: 0, signal: null });
    expect(serve.line("shutting_down")).toMatchObject({ reason: "SIGTERM" });
    expect(existsSync(join(home, "pap.lock"))).toBe(false);
    expect(serve.stderr()).toBe("");
  });

  it("prints the setup address whatever PAP_LOG_LEVEL is, and nothing else below that level (R117)", async () => {
    const serve = run(["serve", "--port", String(await freePort())], join(root, "home"), {
      PAP_LOG_LEVEL: "error",
    });
    await vi.waitFor(() => expect(serve.line("setup_url")).toBeDefined(), { timeout: 20_000 });
    expect(serve.lines.map((line) => line.msg)).toEqual(["setup_url"]);
    serve.child.kill("SIGTERM");
    expect((await serve.exit()).code).toBe(0);
    expect(serve.lines.map((line) => line.msg)).toEqual(["setup_url"]);
  });

  it("exits cleanly with 0 on a SIGTERM sent the moment the setup address is announced (startup window)", async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const serve = run(["serve", "--port", String(await freePort())], join(root, `home-${attempt}`));
      serve.child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.includes("setup_url")) serve.child.kill("SIGTERM");
      });
      expect(await serve.exit()).toEqual({ code: 0, signal: null });
    }
  }, 60_000);

  it.each(["SIGINT", "SIGHUP"] as const)("stops cleanly on %s as well", async (signal) => {
    const serve = run(["serve", "--port", String(await freePort())]);
    await vi.waitFor(() => expect(serve.line("listening")).toBeDefined(), { timeout: 20_000 });
    serve.child.kill(signal);
    expect(await serve.exit()).toEqual({ code: 0, signal: null });
    expect(serve.line("shutting_down")).toMatchObject({ reason: signal });
  });

  // FLAKE-W5-6: "listening" is logged before main installs its handlers, so a signal sent as soon as a script sees that
  // line could still meet the default action (the process dies by the signal, code null). Every signal that comes while
  // the daemon starts now waits for it, and the stop is the graceful one.
  it.each(["SIGINT", "SIGHUP", "SIGTERM"] as const)(
    "a %s that arrives while the daemon is still starting waits for it, then stops cleanly",
    async (signal) => {
      const serve = run(["serve", "--port", String(await freePort())], join(root, "home"), {
        PAP_LOG_LEVEL: "debug",
      });
      // The first log lines are the migrations, well before the daemon listens.
      serve.child.stdout?.once("data", () => serve.child.kill(signal));
      expect(await serve.exit()).toEqual({ code: 0, signal: null });
      expect(serve.line("shutting_down")).toMatchObject({ reason: signal });
      expect(existsSync(join(root, "home", "pap.lock"))).toBe(false);
      expect(serve.stderr()).toBe("");
    },
    30_000,
  );

  it("refuses to start a second daemon on the same home and says why (R70)", async () => {
    const first = run(["serve", "--port", String(await freePort())]);
    await vi.waitFor(() => expect(first.line("listening")).toBeDefined(), { timeout: 20_000 });
    const second = run(["serve", "--port", String(await freePort())]);
    expect(await second.exit()).toEqual({ code: 1, signal: null });
    expect(second.stderr()).toMatch(/^pap: pap is already running on .+ \(pid \d+\)\./);
    expect(second.line("listening")).toBeUndefined();
    expect(
      (await httpRequest(`http://127.0.0.1:${String(first.line("listening")?.port)}/healthz`)).status,
    ).toBe(200);
    first.child.kill("SIGTERM");
    expect((await first.exit()).code).toBe(0);
  });

  it("names the path of a home it cannot use instead of printing a stack trace", async () => {
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, "backups"), "a file where a directory belongs");
    const serve = run(["serve", "--port", String(await freePort())], home);
    expect(await serve.exit()).toEqual({ code: 1, signal: null });
    expect(serve.stderr()).toMatch(new RegExp(`^pap: cannot create ${home}/backups: EEXIST\n$`));
  });

  it("names a port that is taken instead of printing a stack trace", async () => {
    const port = await freePort();
    const first = run(["serve", "--port", String(port)], join(root, "one"));
    await vi.waitFor(() => expect(first.line("listening")).toBeDefined(), { timeout: 20_000 });
    const second = run(["serve", "--port", String(port)], join(root, "two"));
    expect(await second.exit()).toEqual({ code: 1, signal: null });
    expect(second.stderr()).toMatch(/^pap: listen EADDRINUSE/);
    expect(second.stderr()).not.toContain("    at ");
    expect(existsSync(join(root, "two", "pap.lock"))).toBe(false);
  });

  it("answers a bad command line with the usage and exit code 64", async () => {
    for (const args of [
      [],
      ["start"],
      ["audit"],
      ["serve", "--port", "0"],
      ["serve", "--tls-cert", "c.pem"],
    ]) {
      const serve = run(args);
      expect(await serve.exit(), args.join(" ")).toEqual({ code: 64, signal: null });
      expect(serve.stderr(), args.join(" ")).toContain("usage: pap serve");
      expect(serve.stderr(), args.join(" ")).toContain("pap audit prune");
      expect(serve.lines).toEqual([]);
    }
  });

  it("names the flag of a TLS file that is missing or damaged, on one line, with exit code 64", async () => {
    const files = selfSignedCertificate(root);
    const damaged = join(root, "damaged.pem");
    writeFileSync(damaged, "not a pem file\n");
    const cases: Array<[string[], string]> = [
      [
        ["--tls-cert", join(root, "missing.pem"), "--tls-key", files.key],
        "--tls-cert cannot be read (ENOENT)",
      ],
      [
        ["--tls-cert", files.cert, "--tls-key", damaged],
        "--tls-key is not an unencrypted private key in PEM format",
      ],
    ];
    for (const [flags, message] of cases) {
      const serve = run(["serve", "--port", String(await freePort()), ...flags]);
      expect(await serve.exit(), message).toEqual({ code: 64, signal: null });
      expect(serve.stderr().split("\n")[0], message).toBe(`pap: ${message}`);
      expect(serve.stderr(), message).not.toContain("    at ");
      expect(serve.lines).toEqual([]);
    }
  });
});
