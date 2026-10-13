import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../kernel/ids.ts";
import { createPasskeyService, rpIdFor, type WebAuthnLib } from "./passkeys.ts";
import { passkeyRefOf } from "./passkey-store.ts";
import { createAuthStore, type AuthStore } from "./store.ts";
import { createAuthTestBed, type AuthTestBed } from "./testing/fixture.ts";

type Args = Record<string, unknown>;
interface Reply {
  readonly id?: string;
  readonly counter?: number;
  readonly transports?: unknown;
  readonly response?: { userHandle?: unknown };
}

// Records every call so a test can see exactly what the service asked the library to enforce.
function fakeLibrary() {
  const calls: Record<keyof WebAuthnLib, Args[]> = {
    generateRegistrationOptions: [],
    verifyRegistrationResponse: [],
    generateAuthenticationOptions: [],
    verifyAuthenticationResponse: [],
  };
  const lib = {
    generateRegistrationOptions: async (options: Args) => {
      calls.generateRegistrationOptions.push(options);
      return { challenge: "reg-challenge", rp: { id: options.rpID } };
    },
    verifyRegistrationResponse: async (options: Args & { response: Reply }) => {
      calls.verifyRegistrationResponse.push(options);
      if (options.response.id === "boom") throw new Error("library refused");
      return {
        verified: options.expectedChallenge === "reg-challenge",
        registrationInfo: {
          credential: {
            id: options.response.id ?? "cred-1",
            publicKey: new Uint8Array([1, 2, 3]),
            counter: 0,
            transports: options.response.transports ?? ["internal"],
          },
        },
      };
    },
    generateAuthenticationOptions: async (options: Args) => {
      calls.generateAuthenticationOptions.push(options);
      return { challenge: Buffer.from(options.challenge as Uint8Array).toString("base64url") };
    },
    verifyAuthenticationResponse: async (options: Args & { response: Reply; credential: Reply }) => {
      calls.verifyAuthenticationResponse.push(options);
      await Promise.resolve();
      const counter = options.response.counter ?? 5;
      // The real library throws for a counter that did not advance; mirror that.
      if (counter > 0 && counter <= (options.credential.counter ?? 0)) throw new Error("counter regressed");
      return { verified: options.credential.id === "cred-1", authenticationInfo: { newCounter: counter } };
    },
  } as unknown as WebAuthnLib;
  return { lib, calls };
}

let bed: AuthTestBed;
let store: AuthStore;
let calls: ReturnType<typeof fakeLibrary>["calls"];
let lib: WebAuthnLib;
beforeEach(() => {
  bed = createAuthTestBed();
  ({ lib, calls } = fakeLibrary());
  store = createAuthStore(bed.db);
  store.insertFirstUser({ id: "u1", username: "owner", passwordHash: "scrypt$x", createdAt: 0 });
});
afterEach(() => {
  bed.dispose();
});

const service = (publicOrigin = "http://localhost:7777") =>
  createPasskeyService({
    store,
    clock: bed.clock,
    publicOrigin,
    allowedOrigins: new Set([publicOrigin, "http://127.0.0.1:7777", "https://other.example"]),
    lib,
    logger: bed.logger,
  });
const enroll = async (passkeys = service(), id = "cred-1") => {
  const registration = await passkeys.registerOptions("u1", SESSION);
  await passkeys.registerVerify("u1", SESSION, registration.flowId, { id });
};
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

const SESSION = sha256Hex("session-a");
const SIGNED_IN = { userId: "u1", passkeyRef: passkeyRefOf("cred-1") };

describe("passkeyRefOf", () => {
  it("is the first 32 hex characters of the sha256 of the credential id", () => {
    expect(passkeyRefOf("cred-1")).toBe(sha256Hex("cred-1").slice(0, 32));
    expect(passkeyRefOf("cred-1")).toMatch(/^[0-9a-f]{32}$/);
    expect(passkeyRefOf("cred-2")).not.toBe(passkeyRefOf("cred-1"));
  });
});

describe("passkeys", () => {
  it("an IP origin disables passkeys instead of failing", async () => {
    expect(rpIdFor("http://127.0.0.1:7777")).toBeNull();
    expect(rpIdFor("http://[::1]:7777")).toBeNull();
    expect(rpIdFor("not a url")).toBeNull();
    expect(rpIdFor("https://pap.example.ts.net")).toBe("pap.example.ts.net");
    const ip = service("http://127.0.0.1:7777");
    expect(ip.available).toBe(false);
    await expect(ip.loginOptions()).rejects.toThrow(PapError);
    await expect(ip.registerOptions("u1", SESSION)).rejects.toThrow(PapError);
  });

  it("registers, then signs in and stores the new counter", async () => {
    const passkeys = service();
    const registration = await passkeys.registerOptions("u1", SESSION);
    await passkeys.registerVerify("u1", SESSION, registration.flowId, { id: "cred-1" });
    expect(store.findPasskey("cred-1")).toMatchObject({
      userId: "u1",
      counter: 0,
      transports: ["internal"],
      publicKey: new Uint8Array([1, 2, 3]),
    });
    const login = await passkeys.loginOptions();
    expect(await passkeys.loginVerify(login.flowId, { id: "cred-1" })).toEqual(SIGNED_IN);
    expect(store.findPasskey("cred-1")?.counter).toBe(5);
  });

  it("demands user verification in all four calls, and accepts only the public origin's RP ID and origins", async () => {
    const passkeys = service();
    await enroll(passkeys);
    await passkeys.loginVerify((await passkeys.loginOptions()).flowId, { id: "cred-1" });
    expect(calls.generateRegistrationOptions[0]).toMatchObject({
      rpID: "localhost",
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    expect(calls.generateAuthenticationOptions[0]).toMatchObject({
      rpID: "localhost",
      userVerification: "required",
    });
    for (const call of [calls.verifyRegistrationResponse[0], calls.verifyAuthenticationResponse[0]]) {
      expect(call).toMatchObject({
        requireUserVerification: true,
        expectedRPID: "localhost",
        expectedOrigin: ["http://localhost:7777"],
      });
    }
  });

  it("uses a flow once, expires it after five minutes, and binds it to its user", async () => {
    const passkeys = service();
    const registration = await passkeys.registerOptions("u1", SESSION);
    await expect(
      passkeys.registerVerify("u2", SESSION, registration.flowId, { id: "cred-1" }),
    ).rejects.toThrow(PapError);
    await expect(
      passkeys.registerVerify("u1", SESSION, registration.flowId, { id: "cred-1" }),
    ).rejects.toThrow(PapError);
    expect(store.listPasskeys("u1")).toEqual([]);

    await enroll(passkeys);
    const inTime = await passkeys.loginOptions();
    await bed.clock.advance(5 * 60_000 - 1);
    expect(await passkeys.loginVerify(inTime.flowId, { id: "cred-1" })).toEqual(SIGNED_IN);
    const late = await passkeys.loginOptions();
    const lateRegistration = await passkeys.registerOptions("u1", SESSION);
    await bed.clock.advance(5 * 60_000 + 1);
    await expect(passkeys.loginVerify(late.flowId, { id: "cred-1", counter: 6 })).rejects.toThrow(PapError);
    await expect(
      passkeys.registerVerify("u1", SESSION, lateRegistration.flowId, { id: "cred-2" }),
    ).rejects.toThrow(PapError);
    expect(store.listPasskeys("u1")).toHaveLength(1);
  });

  it("does not let a registration flow log in, or a login flow register", async () => {
    const passkeys = service();
    await enroll(passkeys);
    const registration = await passkeys.registerOptions("u1", SESSION);
    await expect(passkeys.loginVerify(registration.flowId, { id: "cred-1" })).rejects.toThrow(PapError);
    const login = await passkeys.loginOptions();
    await expect(passkeys.registerVerify("u1", SESSION, login.flowId, { id: "cred-2" })).rejects.toThrow(
      PapError,
    );
    expect(calls.verifyAuthenticationResponse).toHaveLength(0);
  });

  it("consumes a flow on its first attempt even when verification fails", async () => {
    const passkeys = service();
    const registration = await passkeys.registerOptions("u1", SESSION);
    await expect(passkeys.registerVerify("u1", SESSION, registration.flowId, { id: "boom" })).rejects.toThrow(
      PapError,
    );
    await expect(
      passkeys.registerVerify("u1", SESSION, registration.flowId, { id: "cred-1" }),
    ).rejects.toThrow(PapError);
    expect(calls.verifyRegistrationResponse).toHaveLength(1);
    expect(store.listPasskeys("u1")).toEqual([]);

    await enroll(passkeys);
    const login = await passkeys.loginOptions();
    await expect(passkeys.loginVerify(login.flowId, { id: "unknown" })).rejects.toThrow(PapError);
    expect(calls.verifyAuthenticationResponse).toHaveLength(0);
  });

  it("keeps nothing per sign-in challenge, so no number of them evicts another or an enrollment", async () => {
    const passkeys = service();
    await enroll(passkeys);
    const registration = await passkeys.registerOptions("u1", SESSION);
    const first = await passkeys.loginOptions();
    for (let i = 0; i < 1000; i++) await passkeys.loginOptions();
    expect(await passkeys.loginVerify(first.flowId, { id: "cred-1" })).toEqual(SIGNED_IN);
    await passkeys.registerVerify("u1", SESSION, registration.flowId, { id: "cred-2" });
    expect(store.listPasskeys("u1")).toHaveLength(2);
  });

  it("hands the library its own challenge bytes and uses them as the flow id", async () => {
    const { flowId, options } = await service().loginOptions();
    const challenge = calls.generateAuthenticationOptions[0]?.challenge;
    expect(challenge).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(challenge as Uint8Array).toString("base64url")).toBe(flowId);
    expect(options).toMatchObject({ challenge: flowId });
  });

  it("refuses a challenge from another process, a changed one and a replayed one", async () => {
    const passkeys = service();
    await enroll(passkeys);
    const { flowId } = await passkeys.loginOptions();
    const restarted = service();
    await expect(restarted.loginVerify(flowId, { id: "cred-1" })).rejects.toThrow(PapError);
    const bytes = Buffer.from(flowId, "base64url");
    bytes[3] = (bytes[3] ?? 0) ^ 1;
    await expect(passkeys.loginVerify(bytes.toString("base64url"), { id: "cred-1" })).rejects.toThrow(
      PapError,
    );
    expect(await passkeys.loginVerify(flowId, { id: "cred-1" })).toEqual(SIGNED_IN);
    await expect(passkeys.loginVerify(flowId, { id: "cred-1", counter: 6 })).rejects.toThrow(PapError);
    expect(calls.verifyAuthenticationResponse).toHaveLength(1);
  });

  it("checks the user handle when the authenticator reports one", async () => {
    const passkeys = service();
    await enroll(passkeys);
    const handle = (userId: string) => ({ userHandle: Buffer.from(userId).toString("base64url") });
    const attempt = async (response: Reply, counter: number) =>
      passkeys.loginVerify((await passkeys.loginOptions()).flowId, { id: "cred-1", counter, ...response });
    expect(await rejection(attempt({ response: handle("u2") }, 6))).toBeInstanceOf(PapError);
    expect(await rejection(attempt({ response: { userHandle: 7 } }, 6))).toBeInstanceOf(PapError);
    expect(await rejection(attempt({ response: { userHandle: "" } }, 6))).toBeInstanceOf(PapError);
    expect(calls.verifyAuthenticationResponse).toHaveLength(0);
    expect(await attempt({ response: handle("u1") }, 6)).toEqual(SIGNED_IN);
    expect(await attempt({}, 7)).toEqual(SIGNED_IN);
  });

  it("stores only known transports, whatever the registration response claims", async () => {
    const passkeys = service();
    const claims: [unknown, string[]][] = [
      [
        ["usb", "javascript:alert(1)", 7, null, "internal", "usb"],
        ["usb", "internal"],
      ],
      ["usb", []],
      [{ 0: "usb" }, []],
      [undefined, ["internal"]],
    ];
    for (const [index, [claimed, expected]] of claims.entries()) {
      const { flowId } = await passkeys.registerOptions("u1", SESSION);
      await passkeys.registerVerify("u1", SESSION, flowId, { id: `cred-${index + 1}`, transports: claimed });
      expect(store.findPasskey(`cred-${index + 1}`)?.transports, JSON.stringify(claimed)).toEqual(expected);
    }
  });

  it("reads a damaged transports column as none instead of failing", async () => {
    await enroll(service());
    for (const raw of ["not json", '"usb"', '{"a":1}', '["usb",5,"x"]']) {
      bed.db.run("UPDATE passkeys SET transports = $raw", { raw });
      const expected = raw === '["usb",5,"x"]' ? ["usb"] : [];
      expect(store.findPasskey("cred-1")?.transports, raw).toEqual(expected);
      expect(store.listPasskeys("u1")[0]?.transports, raw).toEqual(expected);
    }
  });

  it("caps pending enrollments at 100 too, evicting the oldest", async () => {
    const passkeys = service();
    const first = await passkeys.registerOptions("u1", SESSION);
    for (let i = 0; i < 99; i++) await passkeys.registerOptions("u1", SESSION);
    await passkeys.registerOptions("u1", SESSION);
    await expect(passkeys.registerVerify("u1", SESSION, first.flowId, { id: "cred-1" })).rejects.toThrow(
      PapError,
    );
    expect(calls.verifyRegistrationResponse).toHaveLength(0);
  });

  it("refuses a credential id that is already registered and keeps the first one intact", async () => {
    const passkeys = service();
    await enroll(passkeys);
    const before = store.findPasskey("cred-1");
    const again = await passkeys.registerOptions("u1", SESSION);
    expect(calls.generateRegistrationOptions[1]).toMatchObject({
      excludeCredentials: [{ id: "cred-1", transports: ["internal"] }],
    });
    const failure = await rejection(passkeys.registerVerify("u1", SESSION, again.flowId, { id: "cred-1" }));
    expect(failure).toBeInstanceOf(PapError);
    expect((failure as PapError).code).toBe("conflict");
    expect(store.listPasskeys("u1")).toEqual([before]);
  });

  it("registers a passkey only for an existing user", async () => {
    const failure = await rejection(service().registerOptions("ghost", SESSION));
    expect(failure).toBeInstanceOf(PapError);
    expect((failure as PapError).code).toBe("unauthenticated");
  });

  it("rejects a counter that did not advance and leaves the stored one alone", async () => {
    const passkeys = service();
    await enroll(passkeys);
    await passkeys.loginVerify((await passkeys.loginOptions()).flowId, { id: "cred-1", counter: 7 });
    expect(store.findPasskey("cred-1")?.counter).toBe(7);
    for (const counter of [7, 3]) {
      const login = await passkeys.loginOptions();
      const failure = await rejection(passkeys.loginVerify(login.flowId, { id: "cred-1", counter }));
      expect((failure as PapError).code).toBe("unauthenticated");
      expect(store.findPasskey("cred-1")?.counter).toBe(7);
    }
    await passkeys.loginVerify((await passkeys.loginOptions()).flowId, { id: "cred-1", counter: 8 });
    expect(store.findPasskey("cred-1")?.counter).toBe(8);
  });

  it("lets only one of two parallel sign-ins on the same counter through", async () => {
    const passkeys = service();
    await enroll(passkeys);
    const [a, b] = [await passkeys.loginOptions(), await passkeys.loginOptions()];
    const results = await Promise.allSettled([
      passkeys.loginVerify(a.flowId, { id: "cred-1", counter: 6 }),
      passkeys.loginVerify(b.flowId, { id: "cred-1", counter: 6 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(store.findPasskey("cred-1")?.counter).toBe(6);
  });
});

describe("an enrollment flow belongs to the session that started it (R85)", () => {
  it("is refused to another session of the same user, and is gone for the first one too", async () => {
    const passkeys = service();
    const registration = await passkeys.registerOptions("u1", SESSION);
    const stolen = passkeys.registerVerify("u1", sha256Hex("session-b"), registration.flowId, {
      id: "cred-1",
    });
    await expect(stolen).rejects.toThrow(new PapError("unauthenticated"));
    await expect(
      passkeys.registerVerify("u1", SESSION, registration.flowId, { id: "cred-1" }),
    ).rejects.toThrow(new PapError("unauthenticated"));
    expect(calls.verifyRegistrationResponse).toHaveLength(0);
    expect(store.listPasskeys("u1")).toEqual([]);
  });

  it("stamps last use with the counter at each sign-in (M5R78)", async () => {
    const passkeys = service();
    await enroll(passkeys);
    expect(bed.db.get("SELECT last_used_at AS at FROM passkeys WHERE id = 'cred-1'")).toEqual({ at: null });
    await bed.clock.advance(1234);
    const login = await passkeys.loginOptions();
    await passkeys.loginVerify(login.flowId, { id: "cred-1" });
    expect(bed.db.get("SELECT last_used_at AS at FROM passkeys WHERE id = 'cred-1'")).toEqual({
      at: bed.clock.now(),
    });
  });

  it("spends no nonce on an answer for an unregistered credential, and logs a full nonce table once per window", async () => {
    const refused = new PapError("unauthenticated");
    const passkeys = service();
    await enroll(passkeys);
    const unknown = await passkeys.loginOptions();
    expect(await rejection(passkeys.loginVerify(unknown.flowId, { id: "nobody" }))).toEqual(refused);
    // The challenge was not used up by that answer.
    expect(await passkeys.loginVerify(unknown.flowId, { id: "cred-1", counter: 1 })).toEqual(SIGNED_IN);

    for (let i = 1; i < 10_000; i++) {
      const { flowId } = await passkeys.loginOptions();
      await passkeys.loginVerify(flowId, { id: "cred-1", counter: i + 1 });
    }
    const { flowId } = await passkeys.loginOptions();
    const late = () => rejection(passkeys.loginVerify(flowId, { id: "cred-1", counter: 20_000 }));
    expect([await late(), await late()]).toEqual([refused, refused]);
    const [entry, ...others] = bed.events("auth_login_challenges_full");
    expect(others).toEqual([]);
    expect(Object.keys(entry ?? {}).sort()).toEqual(["level", "msg", "time"]);
    await bed.clock.advance(10_000);
    expect(await late()).toEqual(refused);
    expect(bed.events("auth_login_challenges_full")).toHaveLength(2);
  }, 60_000);
});
