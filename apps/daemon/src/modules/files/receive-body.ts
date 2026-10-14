import type { Context } from "hono";
import { BoundaryError } from "../../kernel/fs/safe-open.ts";

/** The request body as counted chunks (M8R34): a declared length is required and capped; a body longer than it fails. */
export function receiveBody(
  c: Context,
  maxBytes: number,
): { readonly chunks: AsyncIterable<Uint8Array>; readonly length: number } | Response {
  const declared = c.req.header("content-length");
  if (declared === undefined || !/^\d{1,12}$/.test(declared))
    return c.json({ error: { code: "bad_request" } }, 400);
  const length = Number(declared);
  if (length > maxBytes) return c.json({ error: { code: "payload_too_large" } }, 413);
  const body = c.req.raw.body;
  return {
    length,
    chunks: (async function* () {
      if (body === null) return;
      let total = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > length) throw new BoundaryError("too_large");
        yield chunk;
      }
    })(),
  };
}
