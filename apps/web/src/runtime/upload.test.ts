import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadAttachment, uploadFile, UploadError } from "./upload.ts";

const attachment = { id: "AAAAAAAAAAAAAAAAAAAAAA", name: "a b.png", size: 3, kind: "file", mimeType: null };
const meta = {
  path: "/work/x.txt",
  size: 3,
  mtimeMs: 1,
  etag: null,
  binary: false,
  editable: true,
  protection: "none",
};
const file = (name = "a b.png") => new File([new Uint8Array([1, 2, 3])], name);
const reply = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

function stubFetch(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn((...args: [string, RequestInit?]) => Promise.resolve(args).then(answer));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const online = (value: boolean) => vi.stubGlobal("navigator", { onLine: value });
const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UploadError);
  return (error as UploadError).code;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("uploadAttachment (M8R70)", () => {
  it("POSTs the file to /upload with the session and the encoded name, and decodes the 201", async () => {
    const fetchMock = stubFetch(() => reply(201, attachment));
    const input = file();
    const signal = new AbortController().signal;
    await expect(uploadAttachment("sess_1", input, signal)).resolves.toEqual(attachment);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/upload?sessionId=sess_1&name=a%20b.png");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", body: input, signal });
  });

  it("maps 409 limit_reached, 413, 401 and 503 from the status and the body", async () => {
    stubFetch(() => reply(409, { error: { code: "limit_reached" } }));
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe("limit_reached");
    stubFetch(() => reply(413, { error: { code: "payload_too_large" } }));
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe(
      "payload_too_large",
    );
    stubFetch(() => reply(413, undefined));
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe(
      "payload_too_large",
    );
    stubFetch(() => reply(401, undefined));
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe(
      "unauthenticated",
    );
    stubFetch(() => reply(503, { error: { code: "read_only" } }));
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe("read_only");
  });

  it("falls back to the status when the body carries no known code", async () => {
    stubFetch(() => reply(404, { error: { code: "made_up" } }));
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe("not_found");
    stubFetch(() => reply(500, undefined));
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe("internal");
  });

  it("a 201 whose body is not an attachment is an error, not a value", async () => {
    stubFetch(() => reply(201, { nope: true }));
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe("internal");
  });

  it("refuses a file over the upload cap without sending it", async () => {
    const fetchMock = stubFetch(() => reply(201, attachment));
    const big = { name: "big.bin", size: 25 * 1024 * 1024 + 1 } as File;
    expect(await failure(uploadAttachment("s", big, new AbortController().signal))).toBe("payload_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a rejected fetch is offline when the browser is offline, interrupted otherwise", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")) as never);
    online(false);
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe("offline");
    online(true);
    expect(await failure(uploadAttachment("s", file(), new AbortController().signal))).toBe("interrupted");
  });

  it("lets the caller's own abort through as the abort, not as an interruption", async () => {
    const controller = new AbortController();
    stubFetch(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(uploadAttachment("s", file(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("uploadAttachment abort while reading the answer", () => {
  it("rethrows the caller's abort instead of calling the answer internal", async () => {
    const controller = new AbortController();
    stubFetch(
      () =>
        ({
          ok: true,
          status: 201,
          json: () => {
            controller.abort();
            return Promise.reject(new DOMException("aborted", "AbortError"));
          },
        }) as unknown as Response,
    );
    await expect(uploadAttachment("s", file(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("uploadFile (M8R70)", () => {
  it("PUTs to /files/raw with the path and conflict, and decodes the server's answer (MC38 I1)", async () => {
    const fetchMock = stubFetch(() => reply(200, { written: true, meta }));
    const input = file("x.txt");
    await expect(
      uploadFile("/work/dir/x y.txt", input, { conflict: "skip", signal: new AbortController().signal }),
    ).resolves.toEqual({ written: true, meta });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/files/raw?path=%2Fwork%2Fdir%2Fx%20y.txt&conflict=skip");
    expect(init).toMatchObject({ method: "PUT", credentials: "same-origin", body: input });
  });

  it("decodes a skipped upload and refuses a bare FileMeta", async () => {
    const signal = new AbortController().signal;
    stubFetch(() => reply(200, { written: false }));
    await expect(uploadFile("/w/a", file(), { conflict: "skip", signal })).resolves.toEqual({
      written: false,
    });
    stubFetch(() => reply(200, meta));
    expect(await failure(uploadFile("/w/a", file(), { conflict: "skip", signal }))).toBe("internal");
  });

  it("adds confirmProtected=1 only when asked", async () => {
    const fetchMock = stubFetch(() => reply(200, { written: true, meta }));
    const signal = new AbortController().signal;
    await uploadFile("/w/a", file(), { conflict: "replace", confirmProtected: true, signal });
    await uploadFile("/w/a", file(), { conflict: "replace", confirmProtected: false, signal });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/files/raw?path=%2Fw%2Fa&conflict=replace&confirmProtected=1",
      "/files/raw?path=%2Fw%2Fa&conflict=replace",
    ]);
  });

  it("maps 403 step_up_required, 403 forbidden, 409 protected_path, 409 conflict, 503 capacity", async () => {
    const signal = new AbortController().signal;
    const run = () => uploadFile("/w/a", file(), { conflict: "skip", signal });
    stubFetch(() => reply(403, { error: { code: "step_up_required" } }));
    expect(await failure(run())).toBe("step_up_required");
    stubFetch(() => reply(403, undefined));
    expect(await failure(run())).toBe("forbidden");
    stubFetch(() => reply(409, { error: { code: "protected_path" } }));
    expect(await failure(run())).toBe("protected_path");
    stubFetch(() => reply(409, undefined));
    expect(await failure(run())).toBe("conflict");
    stubFetch(() => reply(503, { error: { code: "capacity" } }));
    expect(await failure(run())).toBe("capacity");
  });

  it("a rejected fetch while online is interrupted", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")) as never);
    online(true);
    const run = uploadFile("/w/a", file(), { conflict: "skip", signal: new AbortController().signal });
    expect(await failure(run)).toBe("interrupted");
  });
});
