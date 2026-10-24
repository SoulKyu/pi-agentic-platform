import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakeClock } from "../../kernel/clock.ts";
import { CLIENT_LIMITS, createGithubClient, errorOf } from "./client.ts";

const withServer = async (
  handler: Parameters<typeof createServer>[1],
  run: (origin: string) => Promise<void>,
): Promise<void> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};
const clientFor = (origin: string) =>
  createGithubClient({ clock: createFakeClock(), apiOrigin: origin, webOrigin: origin, test: true });

describe("github client", () => {
  it("does not follow a redirect", async () => {
    let followed = 0;
    await withServer(
      (req, res) => {
        if (req.url === "/next") followed += 1;
        res.writeHead(302, { location: "/next" }).end();
      },
      async (origin) => {
        await expect(clientFor(origin).text({ path: "/x" })).rejects.toMatchObject({
          code: "github_unavailable",
        });
        expect(followed).toBe(0);
      },
    );
  });

  it("caps the body at 4 MiB and rejects JSON that does not match", async () => {
    await withServer(
      (req, res) => {
        if (req.url === "/big") res.end(Buffer.alloc(CLIENT_LIMITS.maxBytes + 1, 0x61));
        else res.end('{"a":1}');
      },
      async (origin) => {
        const client = clientFor(origin);
        await expect(client.text({ path: "/big" })).rejects.toMatchObject({ code: "github_unavailable" });
        await expect(client.json(z.object({ a: z.string() }), { path: "/ok" })).rejects.toMatchObject({
          code: "github_unavailable",
        });
        expect(await client.json(z.object({ a: z.number() }), { path: "/ok" })).toEqual({ a: 1 });
      },
    );
  });

  it("times out on the clock", async () => {
    const clock = createFakeClock();
    await withServer(
      () => undefined,
      async (origin) => {
        const client = createGithubClient({ clock, apiOrigin: origin, webOrigin: origin, test: true });
        const pending = client.text({ path: "/slow" }).catch((error: unknown) => error);
        await clock.advance(CLIENT_LIMITS.totalMs);
        expect(await pending).toMatchObject({ code: "github_unavailable" });
      },
    );
  });

  it("refuses a name that resolves to a private address (real origins)", async () => {
    const client = createGithubClient({
      clock: createFakeClock(),
      resolve: (_host, _opts, callback) => callback(null, [{ address: "10.0.0.5", family: 4 }]),
    });
    await expect(client.text({ path: "/zen" })).rejects.toMatchObject({ code: "github_unavailable" });
  });

  it("maps statuses", () => {
    expect(errorOf(401, {}).code).toBe("github_unavailable");
    expect(errorOf(403, {}).code).toBe("forbidden");
    expect(errorOf(403, { "x-ratelimit-remaining": "0" }).code).toBe("capacity");
    expect(errorOf(404, {}).code).toBe("not_found");
    expect(errorOf(409, {}).code).toBe("conflict");
    expect(errorOf(422, {}).code).toBe("conflict");
    expect(errorOf(429, {}).code).toBe("capacity");
    expect(errorOf(502, {}).code).toBe("github_unavailable");
  });
});
