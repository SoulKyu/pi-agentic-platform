import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../clock.ts";
import { silentLogger } from "../../logger.ts";
import { PREVIEW_LIMITS } from "./limits.ts";
import { createPreviewListener } from "./listener.ts";

const created = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock("node:https", () => ({
  createServer: (options: Record<string, unknown>, handler: http.RequestListener) => {
    created.options.push(options);
    return http.createServer(handler);
  },
}));

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
  created.options.length = 0;
});

describe("the TLS listener", () => {
  it("bounds a stalled handshake like the request headers", async () => {
    const listener = createPreviewListener({
      appOrigins: [],
      previewOrigin: (port) => `https://127.0.0.1:${port}`,
      grantOf: () => null,
      clock: createFakeClock(),
      logger: silentLogger,
    });
    close = () => listener.close();
    await listener.listen("127.0.0.1", 0, { cert: Buffer.from("c"), key: Buffer.from("k") });
    expect(created.options[0]).toMatchObject({
      handshakeTimeout: PREVIEW_LIMITS.headersMs,
      headersTimeout: PREVIEW_LIMITS.headersMs,
    });
  });
});
