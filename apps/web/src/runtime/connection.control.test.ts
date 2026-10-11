import { PROTOCOL_VERSION } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { backoffDelay, type ProbeResult } from "./connection.ts";
import { connectionBed as setup, flush } from "./testing.ts";

describe("connection supervisor: start and nudge", () => {
  describe("start", () => {
    it("revives a connection that ended signed-out, but not one that is outdated", async () => {
      const signedOut = setup("signed-out");
      signedOut.connection.start();
      signedOut.latest().close();
      await flush();
      expect(signedOut.connection.state).toBe("signed-out");
      signedOut.connection.start();
      expect(signedOut.connection.state).toBe("connecting");
      expect(signedOut.sockets).toHaveLength(2);
      const outdated = setup();
      outdated.connection.start();
      outdated.hello(0);
      outdated.connection.start();
      expect(outdated.connection.state).toBe("outdated");
      expect(outdated.sockets).toHaveLength(1);
    });

    it("begins the backoff again after a stop", async () => {
      const { connection, latest, advance, delays } = setup();
      connection.start();
      for (let attempt = 0; attempt < 3; attempt++) {
        latest().close();
        await flush();
        advance(backoffDelay(attempt, 0.5));
      }
      connection.stop();
      connection.start();
      latest().close();
      await flush();
      expect(delays()).toEqual([backoffDelay(0, 0.5)]);
    });
  });

  describe("nudge", () => {
    it("ends the wait when the probe says signed-out, without a new socket", async () => {
      let answer: ProbeResult = "ok";
      const { connection, latest, sockets, delays } = setup(async () => answer);
      connection.start();
      latest().close();
      await flush();
      answer = "signed-out";
      connection.nudge();
      await flush();
      expect(connection.state).toBe("signed-out");
      expect(sockets).toHaveLength(1);
      expect(delays()).toEqual([]);
    });

    it("does nothing while idle, open, or while a probe is already running", async () => {
      let probes = 0;
      const { connection, hello, latest, sockets } = setup(() => {
        probes++;
        return new Promise<ProbeResult>(() => {});
      });
      connection.nudge();
      expect(connection.state).toBe("idle");
      connection.start();
      hello();
      connection.nudge();
      expect(connection.state).toBe("open");
      latest().close();
      await flush();
      connection.nudge();
      await flush();
      expect(probes).toBe(1);
      expect(sockets).toHaveLength(1);
    });

    it("ignores a probe that answers after a stop", async () => {
      const answers: Array<(result: ProbeResult) => void> = [];
      let calls = 0;
      const { connection, latest, sockets } = setup(() =>
        calls++ === 0 ? Promise.resolve("ok") : new Promise<ProbeResult>((resolve) => answers.push(resolve)),
      );
      connection.start();
      latest().close();
      await flush();
      connection.nudge();
      await flush();
      expect(answers).toHaveLength(1);
      connection.stop();
      answers[0]?.("ok");
      await flush();
      expect(sockets).toHaveLength(1);
      expect(connection.state).toBe("idle");
    });

    it("leaves no timer behind when stopped during a probe", async () => {
      const { connection, latest, timerCount } = setup(() => new Promise<ProbeResult>(() => {}));
      connection.start();
      latest().close();
      await flush();
      expect(timerCount()).toBe(1);
      connection.stop();
      expect(timerCount()).toBe(0);
    });

    it("replaces a socket that is stuck connecting", () => {
      const { connection, hello, latest, sockets } = setup();
      connection.start();
      const stuck = latest();
      connection.nudge();
      expect(stuck.closed).toBe(true);
      expect(sockets).toHaveLength(2);
      expect(connection.state).toBe("connecting");
      stuck.receive({ protocol: PROTOCOL_VERSION, capabilities: [], serverVersion: "0" });
      expect(connection.state).toBe("connecting");
      hello();
      expect(connection.state).toBe("open");
    });
  });
});
