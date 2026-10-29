/// <reference lib="dom" />
// J19: the untrusted origin framed in pap's real page (UX-2, UX2-R86, red team I2). J18 ran an artifact; this runs a stand-in for
// an agent's service in the same signed-in page, with the real PREVIEW_SANDBOX and `referrerpolicy`, on the origin the daemon was
// told is its preview origin (`PAP_PREVIEW_ORIGIN`, so the app's own `frame-src` admits it). It is the one context where WebKit
// sends pap's cookie to a request of the framed page.
//
// The browser reaches `localhost` through the recording proxy of name-proxy.ts: pap's answers to the frame are blocked by CORP or
// CORS before the page, and before Playwright's response events, can see a status; the proxy reads the real one. `localhost` stays
// potentially trustworthy, so the browser still sends Fetch Metadata (J20 is the LAN case, with none).
import { expect, test } from "./fixtures.ts";
import { expectCspStopsEveryProbe, expectNoLeak, reachedPap, withRun } from "./framed.ts";

test.use({ papEnv: { PAP_PREVIEW_ORIGIN: "http://localhost:{standInPort}" }, papProxy: ["localhost"] });

test("the preview's own CSP stops every probe before pap", async ({ pap, signedIn: page }) => {
  await withRun(pap, page, `http://localhost:${pap.standInPort}`, "headers", (run) =>
    expectCspStopsEveryProbe(pap, run),
  );
});

test("under the CSP, pap refuses a same-site page by its Fetch Metadata", async ({
  pap,
  signedIn: page,
  browserName,
}) => {
  await withRun(pap, page, `http://localhost:${pap.standInPort}`, "bare", async (run) => {
    // Only the sandbox and frame-ancestors apply: the requests leave the frame, and pap answers each one itself.
    expect(run.outcome["csp"]).toBeUndefined();
    const received = reachedPap(pap, run);
    expect(received.filter((r) => r.path.startsWith("/files/raw")).length).toBeGreaterThanOrEqual(1);
    expect(received.filter((r) => r.path.startsWith("/upload"))).toHaveLength(1);
    // The browser told pap where the frame comes from (same-site or cross-site, by engine), and pap refused each request itself.
    for (const request of received) {
      // A WebSocket handshake carries it in WebKit only; the Origin rule would refuse `null` either way.
      if (!request.path.startsWith("/ws"))
        expect(["same-site", "cross-site"], request.path).toContain(request.headers["sec-fetch-site"]);
      expect(request.status, request.path).toBe(403);
    }
    // WebKit sends pap's cookie from the framed page: only the Fetch Metadata guard stood between the frame and the owner.
    if (browserName === "webkit")
      for (const request of received) expect(request.headers.cookie).toContain("pap_session=");
    // The socket upgrade was refused (not even pap's hello arrived), the content never reached the frame.
    expect(run.outcome["socket"]).toBe("blocked");
    expect(run.seen.sockets.slice(run.before.sockets).filter((s) => s.received > 0)).toEqual([]);
    expect(run.outcome["read"]).toBe("blocked");
    await expectNoLeak(pap, page, run);
  });
});
