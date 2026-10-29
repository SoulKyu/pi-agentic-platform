import { describe, expect, it } from "vitest";
import { ctx, unitWith } from "../testing/doctor-fixture.ts";
import { makePreviewCheck, type PreviewAnswer, type PreviewProbe } from "./checks-preview.ts";

const probing = (answer: PreviewAnswer | null) => {
  const calls: Array<Parameters<PreviewProbe>[0]> = [];
  const probe: PreviewProbe = async (target) => {
    calls.push(target);
    return answer;
  };
  return { probe, calls };
};
const SANDBOX = { status: 404, csp: "sandbox allow-scripts" };

describe("preview.listener", () => {
  it("is skip when the daemon is not running, and probes nothing", async () => {
    const { probe, calls } = probing(SANDBOX);
    const result = await makePreviewCheck(probe).run(ctx({ lockHeld: false }));
    expect(result.status).toBe("skip");
    expect(calls).toEqual([]);
  });

  it("is ok when GET / answers 404 with a CSP starting sandbox", async () => {
    const { probe } = probing(SANDBOX);
    expect((await makePreviewCheck(probe).run(ctx({ lockHeld: true, unit: unitWith() }))).status).toBe("ok");
  });

  it("fails with the fix when nothing answers", async () => {
    const { probe } = probing(null);
    const result = await makePreviewCheck(probe).run(ctx({ lockHeld: true, unit: unitWith() }));
    expect(result.status).toBe("fail");
    expect(result.fix).toBe(
      "another program holds the preview port: see `preview_listener_unavailable` in the log, or set `PAP_PREVIEW_PORT`",
    );
  });

  it.each([
    ["another status", { status: 200, csp: "sandbox allow-scripts" }],
    ["a missing CSP", { status: 404, csp: null }],
    ["a CSP that is not a sandbox", { status: 404, csp: "default-src 'self'" }],
  ])("warns on %s", async (_name, answer) => {
    const { probe } = probing(answer);
    expect((await makePreviewCheck(probe).run(ctx({ lockHeld: true, unit: unitWith() }))).status).toBe(
      "warn",
    );
  });

  it("probes 127.0.0.1 and main port + 1 by default, over plain http", async () => {
    const { probe, calls } = probing(SANDBOX);
    await makePreviewCheck(probe).run(ctx({ lockHeld: true, unit: unitWith({ port: 7800 }) }));
    expect(calls).toEqual([{ host: "127.0.0.1", port: 7801, tls: false }]);
  });

  it("probes the --preview-port of the unit, the unit's LAN host and its TLS", async () => {
    const { probe, calls } = probing(SANDBOX);
    await makePreviewCheck(probe).run(
      ctx({ lockHeld: true, unit: unitWith({ host: "192.0.2.5", previewPort: 9001, tls: true }) }),
    );
    expect(calls).toEqual([{ host: "192.0.2.5", port: 9001, tls: true }]);
  });

  it("reads PAP_PREVIEW_PORT from the unit's environment, and a wildcard bind is probed on loopback", async () => {
    const { probe, calls } = probing(SANDBOX);
    await makePreviewCheck(probe).run(
      ctx({ lockHeld: true, unit: unitWith({ host: "0.0.0.0", env: { PAP_PREVIEW_PORT: "9100" } }) }),
    );
    expect(calls).toEqual([{ host: "127.0.0.1", port: 9100, tls: false }]);
  });
});
