import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  declaredTooLarge,
  dedupKeyOf,
  HOOK_BODY_MAX_BYTES,
  isHookRequest,
  presentedSecret,
  readCapped,
  sameSecret,
  secretAccepted,
  signatureAccepted,
} from "./hook-auth.ts";

const ID = "0b3c1f6e-6a1d-4c11-8d52-5d8e9a7f3b21";
const SECRET = `pwh_${"a".repeat(43)}`;
const headers = (entries: Record<string, string>) => {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
};
const noWait = () => ({ promise: new Promise<void>(() => {}), cancel: () => {} });

describe("isHookRequest", () => {
  it("accepts exactly POST /hooks/<v4 lower case>", () => {
    expect(isHookRequest("POST", `/hooks/${ID}`)).toBe(true);
  });
  it.each([
    ["trailing slash", "POST", `/hooks/${ID}/`],
    ["upper case", "POST", `/hooks/${ID.toUpperCase()}`],
    ["a v1 id", "POST", "/hooks/0b3c1f6e-6a1d-1c11-8d52-5d8e9a7f3b21"],
    ["a double slash", "POST", `//hooks/${ID}`],
    ["another prefix", "POST", `/api/hooks/${ID}`],
    ["an encoded NUL", "POST", `/hooks/${ID}%00`],
    ["traversal", "POST", `/hooks/${ID}/../../auth/login`],
    ["GET", "GET", `/hooks/${ID}`],
    ["PUT", "PUT", `/hooks/${ID}`],
  ])("refuses %s", (_name, method, path) => {
    expect(isHookRequest(method, path)).toBe(false);
  });
});

describe("presentedSecret", () => {
  it("reads a Bearer in any case, X-Pap-Secret, or both when equal", () => {
    expect(presentedSecret(headers({ authorization: `Bearer ${SECRET}` }))).toBe(SECRET);
    expect(presentedSecret(headers({ authorization: `bearer ${SECRET}` }))).toBe(SECRET);
    expect(presentedSecret(headers({ authorization: `BEARER ${SECRET}` }))).toBe(SECRET);
    expect(presentedSecret(headers({ "x-pap-secret": SECRET }))).toBe(SECRET);
    expect(presentedSecret(headers({ authorization: `Bearer ${SECRET}`, "x-pap-secret": SECRET }))).toBe(
      SECRET,
    );
  });
  it("refuses two different secrets as a whole", () => {
    expect(presentedSecret(headers({ authorization: "Bearer one", "x-pap-secret": "two" }))).toBe("");
  });
  it("ignores a Basic Authorization beside X-Pap-Secret, and alone presents a wrong secret", () => {
    expect(presentedSecret(headers({ authorization: "Basic dXNlcjpwdw==", "x-pap-secret": SECRET }))).toBe(
      SECRET,
    );
    expect(presentedSecret(headers({ authorization: "Basic dXNlcjpwdw==" }))).toBe("");
  });
  it("presents a wrong secret for two spaces or non-ASCII, and null for nothing", () => {
    expect(presentedSecret(headers({ authorization: `Bearer  ${SECRET}` }))).toBe("");
    expect(presentedSecret(headers({ authorization: "Bearer sécret" }))).toBe("");
    expect(presentedSecret(headers({}))).toBeNull();
  });
});

describe("secretAccepted and sameSecret", () => {
  it("checks the header in secret mode and never in hmac mode", () => {
    expect(secretAccepted("secret", headers({ "x-pap-secret": SECRET }), SECRET)).toBe(true);
    expect(secretAccepted("secret", headers({ "x-pap-secret": `${SECRET}x` }), SECRET)).toBe(false);
    expect(secretAccepted("secret", headers({}), SECRET)).toBe(false);
    expect(secretAccepted("secret", headers({ authorization: "Basic abc" }), SECRET)).toBe(false);
    expect(secretAccepted("hmac", headers({}), SECRET)).toBe(true);
  });
  it("compares secrets of any length without throwing", () => {
    expect(sameSecret("", SECRET)).toBe(false);
    expect(sameSecret("x".repeat(10_000), SECRET)).toBe(false);
    expect(sameSecret(SECRET, SECRET)).toBe(true);
  });
});

describe("signatureAccepted", () => {
  const body = new TextEncoder().encode('{"a":1}');
  const hex = createHmac("sha256", SECRET).update(body).digest("hex");
  it("accepts hex with or without sha256=, in any case, trimmed", () => {
    expect(signatureAccepted(hex, SECRET, body)).toBe(true);
    expect(signatureAccepted(`sha256=${hex}`, SECRET, body)).toBe(true);
    expect(signatureAccepted(hex.toUpperCase(), SECRET, body)).toBe(true);
    expect(signatureAccepted(`  sha256=${hex} `, SECRET, body)).toBe(true);
  });
  it.each([
    ["null", null],
    ["empty", ""],
    ["sha1=", `sha1=${hex}`],
    ["63 characters", hex.slice(1)],
    ["66 characters", `${hex}ab`],
    ["zeros", "0".repeat(64)],
  ])("refuses %s", (_name, header) => {
    expect(signatureAccepted(header, SECRET, body)).toBe(false);
  });
  it("refuses a tampered body and another secret", () => {
    expect(signatureAccepted(hex, SECRET, new TextEncoder().encode('{"a":2}'))).toBe(false);
    expect(signatureAccepted(hex, `pwh_${"b".repeat(43)}`, body)).toBe(false);
  });
});

describe("readCapped", () => {
  const chunked = (sizes: number[], pulled: { n: number }) => {
    let index = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled.n++;
          const size = sizes[index++];
          if (size === undefined) controller.close();
          else controller.enqueue(new Uint8Array(size));
        },
      },
      { highWaterMark: 0 },
    );
  };
  it("passes exactly the cap", async () => {
    const result = await readCapped(chunked([32_768, 32_768], { n: 0 }), HOOK_BODY_MAX_BYTES, noWait, 1_000);
    expect(result).toBeInstanceOf(Uint8Array);
    expect((result as Uint8Array).byteLength).toBe(HOOK_BODY_MAX_BYTES);
  });
  it("refuses one byte more at once and never pulls the next chunk", async () => {
    const pulled = { n: 0 };
    const result = await readCapped(chunked([65_536, 1, 5, 5], pulled), HOOK_BODY_MAX_BYTES, noWait, 1_000);
    expect(result).toBe("too_large");
    expect(pulled.n).toBe(2);
  });
  it("counts a stream with no declared length", async () => {
    expect(await readCapped(chunked([40_000, 25_537], { n: 0 }), HOOK_BODY_MAX_BYTES, noWait, 1_000)).toBe(
      "too_large",
    );
  });
  it("answers an empty body for no stream", async () => {
    expect(await readCapped(null, 10, noWait, 1_000)).toEqual(new Uint8Array(0));
  });
  it("is unreadable on a reset stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("reset");
      },
    });
    expect(await readCapped(stream, 10, noWait, 1_000)).toBe("unreadable");
  });
  it("is unreadable at the deadline and cancels the reader", async () => {
    const cancel = vi.fn();
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel });
    let fire: () => void = () => {};
    const wait = () => ({ promise: new Promise<void>((resolve) => (fire = resolve)), cancel: () => {} });
    const pending = readCapped(stalled, 10, wait, 10_000);
    await Promise.resolve();
    fire();
    expect(await pending).toBe("unreadable");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });
});

describe("declaredTooLarge and dedupKeyOf", () => {
  it("refuses a declared length over the cap only", () => {
    expect(declaredTooLarge("65537", HOOK_BODY_MAX_BYTES)).toBe(true);
    expect(declaredTooLarge("65536", HOOK_BODY_MAX_BYTES)).toBe(false);
    expect(declaredTooLarge(null, HOOK_BODY_MAX_BYTES)).toBe(false);
    expect(declaredTooLarge("abc", HOOK_BODY_MAX_BYTES)).toBe(false);
  });
  it("keys equal bodies and equal identities alike", () => {
    const a = new TextEncoder().encode("same");
    expect(dedupKeyOf(null, a)).toBe(dedupKeyOf(null, new TextEncoder().encode("same")));
    expect(dedupKeyOf(null, a)).not.toBe(dedupKeyOf(null, new TextEncoder().encode("other")));
    expect(dedupKeyOf("fp1", a)).toBe(dedupKeyOf("fp1", new TextEncoder().encode("different")));
  });
});
