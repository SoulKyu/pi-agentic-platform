import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { artifactCsp, serviceCsp } from "./csp.ts";
import {
  APP_ORIGIN,
  ARTIFACT_TOKEN,
  type PreviewBed,
  SERVICE_TOKEN,
  seenAt,
  send,
  serviceGrant,
  startPreview,
  startUpstream,
  type Upstream,
} from "./listener-bed.ts";

const P = `/p/${SERVICE_TOKEN}`;
const A = `/a/${ARTIFACT_TOKEN}`;
let upstream: Upstream;
let bed: PreviewBed;
afterEach(async () => {
  await bed.close();
  await upstream.close();
});

async function start(sources: readonly string[] = []): Promise<void> {
  upstream = await startUpstream();
  bed = await startPreview({
    grants: {
      [SERVICE_TOKEN]: serviceGrant(upstream, { sources }),
      [ARTIFACT_TOKEN]: { kind: "artifact", html: "<p>hi</p>" },
    },
  });
}
const noNetwork = () => serviceCsp({ appOrigins: [APP_ORIGIN], previewOrigin: bed.origin, hosts: [] });

describe("the untrusted listener", () => {
  it("answers anything else with a bare 404 carrying the sandbox headers", async () => {
    await start();
    for (const path of ["/", "/healthz", `/p/short/`, `/p/${"Z".repeat(43)}/x`, `//p/${SERVICE_TOKEN}/`]) {
      const answer = await send(bed.port, path);
      expect(answer.status).toBe(404);
      expect(answer.body.length).toBe(0);
      expect(answer.headers["content-security-policy"]).toBe(noNetwork());
      expect(answer.headers["content-security-policy"]).toContain(`default-src ${bed.origin} data: blob:`);
      expect(answer.headers["cache-control"]).toBe("no-store");
      expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect(JSON.stringify(bed.logger.lines)).not.toContain("Z".repeat(43));
    expect(JSON.stringify(bed.logger.lines)).not.toContain(SERVICE_TOKEN);
    expect(bed.logger.lines.some((line) => line.msg === "preview_refused")).toBe(true);
  });

  it("redirects the bare prefix to its slash", async () => {
    await start();
    const answer = await send(bed.port, `${P}?a=1`);
    expect(answer.status).toBe(308);
    expect(answer.headers.location).toBe(`${P}/?a=1`);
    expect(answer.headers["content-security-policy"]).toBe(noNetwork());
    expect((await send(bed.port, `/p/${"Z".repeat(43)}`)).status).toBe(404);
  });

  it("relays a request without pap's cookie, credential or referrer, and drops the service's cookie and CSP", async () => {
    await start();
    upstream.answer = (_req, res) =>
      res
        .writeHead(200, {
          "content-type": "text/html",
          "set-cookie": "sid=1",
          "content-security-policy": "default-src *",
          "access-control-allow-credentials": "true",
          "access-control-allow-origin": "https://pap.test",
          "x-powered-by": "x",
        })
        .end("<p>page</p>");
    const answer = await send(bed.port, `${P}/a/b?c=1`, {
      headers: { cookie: "pap=1", authorization: "Bearer x", referer: `${bed.origin}${P}/`, "x-ok": "1" },
    });
    const seen = seenAt(upstream, 0);
    expect(seen.url).toBe("/a/b?c=1");
    expect(seen.headers["x-forwarded-prefix"]).toBe(P);
    expect(seen.headers["x-ok"]).toBe("1");
    expect(seen.headers.host).toBe(`127.0.0.1:${upstream.port}`);
    for (const name of ["cookie", "authorization", "referer"]) expect(seen.headers).not.toHaveProperty(name);
    expect(answer.status).toBe(200);
    expect(answer.body.toString()).toBe("<p>page</p>");
    expect(answer.headers["set-cookie"]).toBeUndefined();
    expect(answer.headers["x-powered-by"]).toBeUndefined();
    expect(answer.headers["content-security-policy"]).toBe(noNetwork());
    expect(answer.headers["access-control-allow-origin"]).toBe("*");
    expect(answer.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("passes the parsed rest verbatim, a double slash included: it is never an authority", async () => {
    await start();
    await send(bed.port, `${P}//evil.test/x?q=%2F`);
    expect(seenAt(upstream, 0).url).toBe("//evil.test/x?q=%2F");
    expect(seenAt(upstream, 0).headers.host).toBe(`127.0.0.1:${upstream.port}`);
  });

  it("a 401 with WWW-Authenticate reaches the browser as a 401 without it", async () => {
    await start();
    upstream.answer = (_req, res) => res.writeHead(401, { "www-authenticate": 'Basic realm="x"' }).end("no");
    const answer = await send(bed.port, `${P}/`);
    expect(answer.status).toBe(401);
    expect(answer.headers["www-authenticate"]).toBeUndefined();
    expect(answer.body.toString()).toBe("no");
  });

  it("a service's page carries the CSP of its grant: the no-network one, or its sources in connect-src, form-action and frame-src", async () => {
    await start(["https://api.example.test", "wss://api.example.test"]);
    const answer = await send(bed.port, `${P}/`);
    const csp = String(answer.headers["content-security-policy"]);
    expect(csp).toBe(
      serviceCsp({
        appOrigins: [APP_ORIGIN],
        previewOrigin: bed.origin,
        hosts: ["https://api.example.test", "wss://api.example.test"],
      }),
    );
    for (const directive of ["connect-src", "form-action", "frame-src"])
      expect(csp).toMatch(new RegExp(`${directive}[^;]*https://api.example.test`));
    await bed.close();
    await upstream.close();
    await start();
    expect(String((await send(bed.port, `${P}/`)).headers["content-security-policy"])).toBe(noNetwork());
  });

  it("never follows a redirect: inside it is rewritten, outside it loses its Location", async () => {
    await start();
    const redirect = async (location: string) => {
      upstream.answer = (_req, res) => res.writeHead(302, { location }).end("moved");
      return send(bed.port, `${P}/dir/page?x=1`);
    };
    expect((await redirect("/inside?y=2")).headers.location).toBe(`${P}/inside?y=2`);
    expect((await redirect("next")).headers.location).toBe(`${P}/dir/next`);
    expect((await redirect(`http://127.0.0.1:${upstream.port}/own`)).headers.location).toBe(`${P}/own`);
    for (const outside of ["http://evil.test/x", "//evil.test/x", "https://127.0.0.1/", "../../escape"]) {
      const answer = await redirect(outside);
      expect(answer.status).toBe(302);
      expect(answer.headers.location).toBeUndefined();
    }
    expect(upstream.seen.length).toBe(7);
  });

  it("answers a preflight the service ignores with what the page asked, never credentials", async () => {
    await start();
    upstream.answer = (_req, res) => res.writeHead(404).end("nope");
    const preflight = (method: string, headers: string) =>
      send(bed.port, `${P}/api`, {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": method,
          "access-control-request-headers": headers,
        },
      });
    const answer = await preflight("PUT", "x-a, content-type");
    expect(answer.status).toBe(204);
    expect(answer.headers["access-control-allow-methods"]).toBe("PUT");
    expect(answer.headers["access-control-allow-headers"]).toBe("x-a, content-type");
    expect(answer.headers["access-control-allow-origin"]).toBe("*");
    expect(answer.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(seenAt(upstream, 0).method).toBe("OPTIONS");
    const odd = await preflight("put", `${"a".repeat(1025)}`);
    expect(odd.headers["access-control-allow-methods"]).toBeUndefined();
    expect(odd.headers["access-control-allow-headers"]).toBeUndefined();
    // The service's own CORS answer wins.
    upstream.answer = (_req, res) =>
      res.writeHead(200, { "access-control-allow-methods": "GET" }).end("mine");
    const own = await preflight("PUT", "x-a");
    expect([own.status, own.headers["access-control-allow-methods"]]).toEqual([200, "GET"]);
  });

  it("serves an artifact only framed, with no network", async () => {
    await start();
    const framed = await send(bed.port, `${A}/?x=1`, { headers: { "sec-fetch-dest": "iframe" } });
    expect(framed.status).toBe(200);
    expect(framed.body.toString()).toBe("<p>hi</p>");
    expect(framed.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(framed.headers["content-security-policy"]).toBe(artifactCsp([APP_ORIGIN]));
    expect((await send(bed.port, `${A}/`)).status).toBe(200);
    const head = await send(bed.port, `${A}/`, { method: "HEAD" });
    expect([head.status, head.body.length, head.headers["content-length"]]).toEqual([200, 0, "9"]);
    for (const refused of [
      send(bed.port, `${A}/`, { headers: { "sec-fetch-dest": "document" } }),
      send(bed.port, `${A}/other`, { headers: { "sec-fetch-dest": "iframe" } }),
      send(bed.port, `${A}/`, { method: "POST", headers: { "sec-fetch-dest": "iframe" }, body: "x" }),
      send(bed.port, `/p/${ARTIFACT_TOKEN}/`),
      send(bed.port, `/a/${SERVICE_TOKEN}/`),
      send(bed.port, `/a/${SERVICE_TOKEN}`),
      send(bed.port, `/p/${ARTIFACT_TOKEN}`),
    ])
      expect((await refused).status).toBe(404);
    expect(bed.logger.lines.some((line) => line.fields?.reason === "dest_refused")).toBe(true);
    expect(upstream.seen).toEqual([]);
  });

  it("refuses a service loaded top-level (Sec-Fetch-Dest document) before the box is touched, and relays the rest", async () => {
    upstream = await startUpstream();
    const touched: string[] = [];
    bed = await startPreview({
      grants: { [SERVICE_TOKEN]: serviceGrant(upstream) },
      onTraffic: (box) => touched.push(box),
    });
    const top = await send(bed.port, `${P}/`, { headers: { "sec-fetch-dest": "document" } });
    expect(top.status).toBe(404);
    expect(bed.logger.lines.some((line) => line.fields?.reason === "dest_refused")).toBe(true);
    expect(upstream.seen).toEqual([]);
    expect(touched).toEqual([]);
    for (const dest of ["iframe", "empty", "image"]) {
      const answer = await send(bed.port, `${P}/`, { headers: { "sec-fetch-dest": dest } });
      expect(answer.status).toBe(200);
    }
    expect((await send(bed.port, `${P}/`)).status).toBe(200);
    // An upgrade carries websocket (or nothing) and is not affected.
    const socket = new WebSocket(`ws://127.0.0.1:${bed.port}${P}/ws`, {
      headers: { "sec-fetch-dest": "websocket" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });
    socket.close();
  });

  it("survives a grant lookup that throws: that connection is cut, the next request is served", async () => {
    upstream = await startUpstream();
    bed = await startPreview({
      grants: { [SERVICE_TOKEN]: serviceGrant(upstream) },
      throwOn: "T".repeat(43),
    });
    await expect(send(bed.port, `/p/${"T".repeat(43)}/`)).rejects.toThrow();
    expect((await send(bed.port, `${P}/`)).status).toBe(200);
    expect(bed.logger.lines.some((line) => line.msg === "preview_dispatch_failed")).toBe(true);
  });
});
