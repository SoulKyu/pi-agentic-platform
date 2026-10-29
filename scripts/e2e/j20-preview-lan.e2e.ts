/// <reference lib="dom" />
// J20: the untrusted origin in the owner's real LAN mode (UX-2, UX2-R87, decision 139, red team I1). Plain HTTP to a LAN address
// (`--host <LAN IP> --insecure-http`) is not a potentially trustworthy origin, so no browser sends Fetch Metadata there and the
// Sec-Fetch-Site refusal never fires: the guarantees rest on the layers below it (CORS/CORP, the Origin guard, the WebSocket Origin
// rule). J18's `localhost` cannot show that, so pap and the stand-in are reached as `pap.test` through a forward proxy on loopback
// (name-proxy.ts): the same property, with nothing listening on a LAN address (the daemon is bound to 127.0.0.1).
//
// Container-mode browsers run with `--network host` (docs/agents/e2e.md), so they dial the proxy on the host's loopback; a browser
// server on another network cannot, and the journey then fails at its first request instead of passing.
// WebKit cannot open a WebSocket through an HTTP proxy (libsoup sends the handshake without its Upgrade headers; the control below
// shows even pap's own socket fails), so the socket leg is proven at the wire for both engines by a handshake sent from Node with
// the headers a framed page would carry, and in the browser for Chromium.
import { WebSocket } from "ws";
import { expect, test } from "./fixtures.ts";
import { expectCspStopsEveryProbe, expectNoLeak, reachedPap, withRun } from "./framed.ts";

test.use({
  papArgs: ["--insecure-http"],
  papProxy: ["pap.test"],
  papEnv: {
    PAP_PUBLIC_ORIGIN: "http://pap.test:{port}",
    PAP_PREVIEW_ORIGIN: "http://pap.test:{standInPort}",
  },
});

/** The status of a WebSocket handshake with these headers (101 when it opened), sent to the daemon on loopback. */
function handshake(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?proto=2`, { headers });
    socket.once("open", () => {
      socket.close();
      resolve(101);
    });
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("error", reject);
  });
}

test("in LAN mode the CSP still stops every probe", async ({ pap, signedIn: page }) => {
  await withRun(pap, page, `http://pap.test:${pap.standInPort}`, "headers", (run) =>
    expectCspStopsEveryProbe(pap, run),
  );
});

test("in LAN mode, with no Fetch Metadata and pap's cookie sent, the remaining layers hold", async ({
  pap,
  signedIn: page,
  browserName,
}) => {
  await withRun(pap, page, `http://pap.test:${pap.standInPort}`, "bare", async (run) => {
    const reached = reachedPap(pap, run);
    const reads = reached.filter((r) => r.path.startsWith("/files/raw"));
    const posts = reached.filter((r) => r.path.startsWith("/upload"));
    expect(reads.length, "the frame's reads reached pap").toBeGreaterThanOrEqual(1);
    expect(posts, "the frame's post reached pap").toHaveLength(1);

    // The premise: a request pap receives carries no Fetch Metadata at all, so the T2 refusal had nothing to act on.
    for (const request of reached)
      expect(
        Object.keys(request.headers).filter((name) => name.startsWith("sec-fetch-")),
        request.path,
      ).toEqual([]);

    // The post: `Origin: null` is refused by the Origin guard, cookie or not.
    expect(posts[0]?.headers.origin).toBe("null");
    expect(posts[0]?.status).toBe(403);

    // The reads. Chromium keeps pap's SameSite=Strict cookie from the sandboxed frame (401); WebKit sends it, and pap answers 200
    // with CORP `same-origin`: the answer exists, and the browser hands the frame nothing of it.
    for (const request of reads) {
      if (request.status === 200)
        expect(request.answerHeaders?.["cross-origin-resource-policy"]).toBe("same-origin");
      else expect(request.status).toBe(401);
    }
    if (browserName === "webkit") {
      const answered = reads.filter((r) => r.status === 200);
      expect(answered.length, "WebKit's frame reads are answered 200").toBeGreaterThanOrEqual(1);
      for (const request of answered) expect(request.headers.cookie).toContain(`pap_session=${run.cookie}`);
    }
    const canary = run.seen.failures.filter((f) => f.includes("/files/raw"));
    expect(canary.length).toBeGreaterThanOrEqual(1);
    for (const failure of canary)
      expect(failure).toMatch(
        /NotSameOrigin|ERR_FAILED|Cross-Origin-Resource-Policy|Access-Control-Allow-Origin/u,
      );
    expect(run.outcome).toMatchObject({ read: "blocked", readNoCors: "blocked", socket: "blocked" });
    expect(run.seen.sockets.slice(run.before.sockets).filter((s) => s.received > 0)).toEqual([]);

    // The socket, at the wire: the handshake of a framed page (`Origin: null`, pap's cookie, no Fetch Metadata) is refused; the
    // same handshake with pap's own origin opens, so the refusal is the Origin rule's.
    const cookie = `pap_session=${run.cookie}`;
    expect(await handshake(pap.port, { origin: "null", cookie })).toBe(403);
    expect(await handshake(pap.port, { origin: pap.origin, cookie })).toBe(101);
    if (browserName === "chromium") {
      const upgrade =
        pap.proxy?.requests.filter((r) => r.path.startsWith("/ws") && r.headers.origin === "null") ?? [];
      expect(upgrade.map((r) => r.status)).toEqual([403]);
    }
    await expectNoLeak(pap, page, run);
  });
});
