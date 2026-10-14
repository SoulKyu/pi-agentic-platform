import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { BoundaryError } from "../../kernel/fs/safe-open.ts";
import { receiveBody } from "./receive-body.ts";

const MAX = 25 * 1024 * 1024;

/** Runs `receiveBody` inside a route on a synthetic request: an over-long body cannot travel over HTTP/1.1 (RT-23). */
async function run(headers: Record<string, string>, body: ReadableStream<Uint8Array> | null) {
  let outcome: ReturnType<typeof receiveBody> | undefined;
  const app = new Hono().put("/x", (c) => {
    outcome = receiveBody(c, MAX);
    return outcome instanceof Response ? outcome : c.text("ok");
  });
  const res = await app.request("/x", { method: "PUT", headers, body, duplex: "half" } as RequestInit);
  return { res, outcome };
}

const streamOf = (chunks: Uint8Array[], onPull?: () => void) => {
  let next = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull?.();
        const chunk = chunks[next++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
};

describe("receiveBody", () => {
  it("answers 400 without a Content-Length", async () => {
    const { res } = await run({}, streamOf([new Uint8Array(3)]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_request" } });
  });

  it("answers 400 to a length that is not decimal", async () => {
    for (const length of ["0x10", "-1", "1e3", "", "1 2", "1234567890123"]) {
      const { res } = await run({ "content-length": length }, streamOf([]));
      expect(res.status, length).toBe(400);
    }
  });

  it("answers 413 above the cap and never pulls the body", async () => {
    let pulled = 0;
    const { res } = await run(
      { "content-length": "26214401" },
      streamOf([new Uint8Array(3)], () => pulled++),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: "payload_too_large" } });
    expect(pulled).toBe(0);
  });

  it("accepts a length exactly at the cap", async () => {
    const { res, outcome } = await run({ "content-length": String(MAX) }, streamOf([]));
    expect(res.status).toBe(200);
    expect(outcome).toMatchObject({ length: MAX });
  });

  it("yields the chunks of a body of the announced length", async () => {
    const { outcome } = await run(
      { "content-length": "6" },
      streamOf([Buffer.from("abc"), Buffer.from("def")]),
    );
    if (outcome === undefined || outcome instanceof Response) throw new Error("refused");
    const got: string[] = [];
    for await (const chunk of outcome.chunks) got.push(Buffer.from(chunk).toString());
    expect(got.join("")).toBe("abcdef");
    expect(outcome.length).toBe(6);
  });

  it("throws too_large when the body is longer than its length", async () => {
    const { outcome } = await run({ "content-length": "5" }, streamOf([Buffer.alloc(10, 1)]));
    if (outcome === undefined || outcome instanceof Response) throw new Error("refused");
    const failure = await (async () => {
      for await (const chunk of outcome.chunks) void chunk;
    })().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoundaryError);
    expect((failure as BoundaryError).reason).toBe("too_large");
  });

  it("yields nothing for an empty body", async () => {
    const { outcome } = await run({ "content-length": "0" }, null);
    if (outcome === undefined || outcome instanceof Response) throw new Error("refused");
    const got: Uint8Array[] = [];
    for await (const chunk of outcome.chunks) got.push(chunk);
    expect(got).toEqual([]);
  });
});
