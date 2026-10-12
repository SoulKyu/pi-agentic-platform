import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { PROTOCOL_VERSION } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createStreamHub } from "./stream-hub.ts";
import { createWsServer, type Credential } from "./ws-server.ts";

const ALLOWED = "http://localhost:7777";
const COOKIE = "cookie-value";
const TOKEN = "pap_token-value";

function credentialOf(headers: {
  cookie?: string;
  authorization?: string;
}): Credential | "conflict" | undefined {
  const cookie = headers.cookie?.startsWith("pap_session=") ? headers.cookie.slice(12) : undefined;
  const bearer = headers.authorization?.startsWith("Bearer ") ? headers.authorization.slice(7) : undefined;
  if (cookie !== undefined && bearer !== undefined) return "conflict";
  if (cookie !== undefined) return { kind: "cookie", value: cookie };
  if (bearer !== undefined) return { kind: "bearer", value: bearer };
  return undefined;
}

interface Headers {
  cookie?: string;
  authorization?: string;
  origin?: string;
  url?: string;
}

async function upgrade(headers: Headers, refusals: Array<[string, string | undefined]> = []) {
  const server = createWsServer({
    allowedOrigins: new Set([ALLOWED]),
    onOriginRefused: (via, origin) => refusals.push([via, origin]),
    credentialOf,
    authenticate: (credential) =>
      credential?.value === COOKIE || credential?.value === TOKEN ? testCaller() : null,
    dispatch: () => Promise.reject(new Error("unused")),
    hub: createStreamHub("e"),
    logger: silentLogger,
    clock: createFakeClock(),
    serverVersion: "0.0.0-test",
  });
  const written: string[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });
  const { url, ...rest } = headers;
  const finished = once(socket, "finish");
  // The method is POST on purpose: a request that passes every check of this server reaches `ws`, which refuses
  // it with 405, so 405 reads "accepted here" without a real handshake.
  server.handleUpgrade(
    {
      method: "POST",
      url: url ?? `/ws?proto=${PROTOCOL_VERSION}`,
      headers: rest,
    } as unknown as IncomingMessage,
    socket,
    Buffer.alloc(0),
  );
  await finished;
  server.close();
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(written.join(""))?.[1] ?? 0);
}

describe("credentials on the upgrade (M5R70)", () => {
  it.each([
    ["a bearer without Origin", { authorization: `Bearer ${TOKEN}` }, 101],
    ["a bearer with an allowed Origin", { authorization: `Bearer ${TOKEN}`, origin: ALLOWED }, 101],
    [
      "a bearer with a foreign Origin",
      { authorization: `Bearer ${TOKEN}`, origin: "https://evil.test" },
      403,
    ],
    ["a cookie with an allowed Origin", { cookie: `pap_session=${COOKIE}`, origin: ALLOWED }, 101],
    ["a cookie without Origin", { cookie: `pap_session=${COOKIE}` }, 403],
    [
      "a cookie and a bearer",
      { cookie: `pap_session=${COOKIE}`, authorization: `Bearer ${TOKEN}`, origin: ALLOWED },
      400,
    ],
    [
      "a cookie and a bearer without Origin",
      { cookie: `pap_session=${COOKIE}`, authorization: `Bearer ${TOKEN}` },
      400,
    ],
    [
      "a cookie and a bearer with a foreign Origin",
      { cookie: `pap_session=${COOKIE}`, authorization: `Bearer ${TOKEN}`, origin: "https://evil.test" },
      403,
    ],
    ["nothing, without Origin", {}, 403],
    ["nothing, with an allowed Origin", { origin: ALLOWED }, 401],
    ["a Basic header, with an allowed Origin", { authorization: "Basic dXNlcjpwYXNz", origin: ALLOWED }, 401],
    ["a wrong bearer without Origin", { authorization: "Bearer pap_nope" }, 401],
    [
      "a token in the query string",
      { origin: ALLOWED, url: `/ws?proto=${PROTOCOL_VERSION}&token=${TOKEN}` },
      401,
    ],
  ] as const)("%s", async (_name, headers, status) => {
    const answered = await upgrade(headers as Headers);
    expect(answered).toBe(status === 101 ? 405 : status);
  });

  it("logs a refused Origin for a bearer as for a cookie, and a missing Origin for a cookie", async () => {
    const refusals: Array<[string, string | undefined]> = [];
    await upgrade({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.test" }, refusals);
    await upgrade({ cookie: `pap_session=${COOKIE}` }, refusals);
    expect(refusals).toEqual([
      ["ws", "https://evil.test"],
      ["ws", undefined],
    ]);
  });
});
