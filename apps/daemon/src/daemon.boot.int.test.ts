import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "./kernel/clock.ts";
import { InstanceLockError } from "./kernel/home.ts";
import { createLogger } from "./kernel/logger.ts";
import { httpRequest } from "./testing/http-client.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

const ANSWER = { steps: [{ text: "a scripted answer" }] };

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock: createSystemClock(),
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { lines, logger, named: (msg: string) => lines.filter((line) => line.msg === msg) };
}

const started: TestDaemon[] = [];
async function boot(...args: Parameters<typeof startTestDaemon>): Promise<TestDaemon> {
  const daemon = await startTestDaemon(...args);
  started.push(daemon);
  return daemon;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const daemon of started.splice(0).reverse()) await daemon.stop();
});

describe("what the daemon does at boot", () => {
  it("refuses a second daemon on the same home and frees the home when the first one stops (R70)", async () => {
    const first = await boot(ANSWER);
    const refused = await startTestDaemon(ANSWER, { config: { home: first.home } }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(InstanceLockError);
    expect((refused as Error).message).toContain(`pap is already running on ${first.home}`);
    expect((await httpRequest(`${first.base}/healthz`)).status).toBe(200);
    await first.daemon.stop();
    expect(existsSync(join(first.home, "pap.lock"))).toBe(false);
    const again = await boot(ANSWER, { config: { home: first.home } });
    expect((await httpRequest(`${again.base}/healthz`)).status).toBe(200);
  });

  it("gives back the lock and the database when the port is taken", async () => {
    const taken = await boot(ANSWER);
    const home = join(tmpdir(), `pap-port-taken-${process.pid}`);
    try {
      const failed = await startTestDaemon(ANSWER, { config: { port: taken.port, home } }).catch(
        (error: unknown) => error,
      );
      expect((failed as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
      expect(existsSync(join(home, "pap.lock"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prints the setup address once, and none once an owner exists", async () => {
    const { logger, named } = capture();
    const t = await boot(ANSWER, { deps: { logger } });
    expect(named("setup_url")).toHaveLength(1);
    expect(named("setup_url")[0]?.url).toBe(t.daemon.setupUrl);
    expect(t.daemon.setupUrl).toMatch(new RegExp(`^${t.origin}/setup#token=[\\w-]{20,}$`));
    expect(named("listening")).toEqual([
      expect.objectContaining({ url: t.origin, port: t.port, host: "127.0.0.1" }),
    ]);
    await t.login();
    await t.daemon.stop();
    const again = capture();
    await boot(ANSWER, { config: { home: t.home }, deps: { logger: again.logger } });
    expect(again.named("setup_url")).toHaveLength(0);
    expect(again.named("listening")).toHaveLength(1);
  });

  it("hands the setup address to the announcer instead of the logger when it has one (R117)", async () => {
    // main.ts announces it whatever PAP_LOG_LEVEL is: an operator cannot create the owner without it.
    const { logger, named } = capture();
    const announced: Array<{ url: string }> = [];
    const t = await boot(ANSWER, { deps: { logger, announceSetupUrl: (fields) => announced.push(fields) } });
    expect(announced).toEqual([expect.objectContaining({ url: t.daemon.setupUrl })]);
    expect(named("setup_url")).toHaveLength(0);
  });

  it("prints the setup address on the Vite origin in --dev (R31)", async () => {
    const { logger, named } = capture();
    const t = await boot(ANSWER, { config: { dev: true }, deps: { logger } });
    const url = named("setup_url")[0]?.url;
    expect(url).toBe(t.daemon.setupUrl);
    expect(url).toMatch(/^http:\/\/localhost:5173\/setup#token=[\w-]{20,}$/);
    expect(named("listening")[0]?.url).toBe(t.origin);
  });

  it("warns when it serves plain http beyond the loopback", async () => {
    const { logger, named } = capture();
    await boot(ANSWER, { config: { host: "0.0.0.0" }, deps: { logger } });
    expect(named("plain_http_on_network")).toHaveLength(1);
    const quiet = capture();
    await boot(ANSWER, { deps: { logger: quiet.logger } });
    expect(quiet.named("plain_http_on_network")).toHaveLength(0);
  });

  it("logs every late server error by its code alone, and hands the daemon over once (R75, R115)", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const { logger, named } = capture();
    const onFatal = vi.fn();
    await boot(ANSWER, { deps: { logger, onFatal } });
    const instance = listen.mock.contexts[0] as Server;
    const late = Object.assign(new Error("accept failed for /home/someone/secret"), { code: "EMFILE" });
    expect(() => instance.emit("error", late)).not.toThrow();
    expect(() => instance.emit("error", late)).not.toThrow();
    // A second call would count as a second signal to the owner and SIGKILL the workers before they cleaned up.
    expect(onFatal).toHaveBeenCalledExactlyOnceWith("server_error");
    expect(named("server_error")).toEqual([
      expect.objectContaining({ level: "error", code: "EMFILE" }),
      expect.objectContaining({ level: "error", code: "EMFILE" }),
    ]);
    expect(JSON.stringify(named("server_error"))).not.toContain("secret");
  });
});

describe("the composed http app", () => {
  it("sends the CSP, and HSTS only when it serves TLS itself (R73, R74)", async () => {
    const plain = await boot(ANSWER);
    const csp = (await httpRequest(`${plain.base}/healthz`)).headers["content-security-policy"];
    expect(csp).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    expect((await httpRequest(`${plain.base}/healthz`)).headers["strict-transport-security"]).toBeUndefined();
    const secure = await boot(ANSWER, { tls: true });
    const reply = await httpRequest(`${secure.base}/healthz`);
    expect(reply.status).toBe(200);
    expect(reply.headers["strict-transport-security"]).toBe("max-age=15552000");
    expect(reply.headers["content-security-policy"]).toBe(csp);
  });

  it("answers 404 under every reserved prefix and still serves the app elsewhere (R78)", async () => {
    const web = join(tmpdir(), `pap-web-${process.pid}`);
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html><title>pap</title>");
    try {
      const t = await boot(ANSWER, { config: { staticRoot: web } });
      for (const path of [
        "/auth/nothing",
        "/api/nothing",
        "/files/a",
        "/upload/a",
        "/hooks/a",
        "/metrics",
        "/ws/a",
      ]) {
        const reply = await httpRequest(`${t.base}${path}`);
        expect([reply.status, JSON.parse(reply.body)], path).toEqual([404, { error: { code: "not_found" } }]);
      }
      const post = await httpRequest(`${t.base}/api/nothing`, {
        method: "POST",
        headers: { origin: t.origin },
      });
      expect(post.status).toBe(404);
      expect((await httpRequest(`${t.base}/s/abc`)).body).toContain("<title>pap</title>");
      expect((await httpRequest(`${t.base}/auth/status`)).status).toBe(200);
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });

  it("answers the websocket probe: 426 for another protocol, 401 without a session, 200 with one", async () => {
    const t = await boot(ANSWER);
    for (const query of ["", "?proto=0", `?proto=${PROTOCOL_VERSION + 1}`, "?proto=x"]) {
      const reply = await httpRequest(`${t.base}/ws${query}`);
      expect([reply.status, JSON.parse(reply.body)], query).toEqual([426, { protocol: PROTOCOL_VERSION }]);
    }
    const anonymous = await httpRequest(`${t.base}/ws?proto=${PROTOCOL_VERSION}`);
    expect([anonymous.status, JSON.parse(anonymous.body)]).toEqual([
      401,
      { error: { code: "unauthenticated" } },
    ]);
    const cookie = await t.login();
    const signedIn = await httpRequest(`${t.base}/ws?proto=${PROTOCOL_VERSION}`, { headers: { cookie } });
    expect([signedIn.status, JSON.parse(signedIn.body)]).toEqual([200, { protocol: PROTOCOL_VERSION }]);
    const stale = await httpRequest(`${t.base}/ws?proto=0`, { headers: { cookie } });
    expect(stale.status).toBe(426);
  });
});

describe("stopping", () => {
  it("is idempotent", async () => {
    const t = await boot(ANSWER);
    const first = t.daemon.stop();
    expect(t.daemon.stop()).toBe(first);
    await first;
    await expect(httpRequest(`${t.base}/healthz`)).rejects.toThrow();
  });

  it("lets a worker clean up Pi's bash tree before anything is killed outright (R104)", async () => {
    // Pi starts every command in a group of its own, out of reach of the SIGKILL to the worker's group: only the
    // worker itself, asked to shut down or sent SIGTERM, ends it. `exec` makes $$ the pid of the sleeper.
    const pidFile = join(tmpdir(), `pap-stop-order-${process.pid}.pid`);
    rmSync(pidFile, { force: true });
    const command = `echo $$ > ${pidFile}; exec sleep 120`;
    const t = await boot({
      steps: [{ toolCalls: [{ name: "bash", args: { command }, id: "call-1" }] }, { text: "done" }],
    });
    let sleeper = 0;
    try {
      const client = await t.connect(await t.login());
      const created = await client.call("sessions.create", { cwd: t.cwd });
      const sessionId = (created as { result: { sessionId: string } }).result.sessionId;
      await client.call("subscribe.session", { sessionId });
      await client.call("sessions.prompt", { sessionId, text: "Run the check" });
      const open = await client.waitForEvent((f) => (f.event as { kind?: string }).kind === "dialog_open");
      const dialogId = (open.event as { dialog: { id: string } }).dialog.id;
      await client.call("sessions.respondDialog", { sessionId, dialogId, response: { confirmed: true } });
      await vi.waitFor(() => expect(readFileSync(pidFile, "utf8").trim()).toMatch(/^\d+$/), {
        timeout: 20_000,
      });
      sleeper = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(sleeper, 0)).not.toThrow();
      await t.daemon.stop();
      // A killed process is gone for good once its parent has reaped it, a moment after the signal.
      await vi.waitFor(() => expect(() => process.kill(sleeper, 0)).toThrow(/ESRCH/), { timeout: 5000 });
    } finally {
      if (sleeper > 1) {
        try {
          process.kill(sleeper, "SIGKILL");
        } catch {
          // already gone: what the test wants
        }
      }
      rmSync(pidFile, { force: true });
    }
  });
});
