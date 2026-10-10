import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AUTH_MIGRATIONS } from "./index.ts";
import { createPasskeyService, rpIdFor, type WebAuthnLib } from "./passkeys.ts";
import { createAuthStore, type AuthStore } from "./store.ts";

type Args = Record<string, unknown>;
interface Reply {
  readonly id?: string;
  readonly counter?: number;
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
            transports: ["internal"],
          },
        },
      };
    },
    generateAuthenticationOptions: async (options: Args) => {
      calls.generateAuthenticationOptions.push(options);
      return { challenge: "auth-challenge" };
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

let dir: string;
let db: Db;
let store: AuthStore;
let clock: FakeClock;
let calls: ReturnType<typeof fakeLibrary>["calls"];
let lib: WebAuthnLib;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-passkeys-"));
  clock = createFakeClock();
  ({ lib, calls } = fakeLibrary());
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  store = createAuthStore(db);
  store.insertFirstUser({ id: "u1", username: "owner", passwordHash: "scrypt$x", createdAt: 0 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const service = (publicOrigin = "http://localhost:7777") =>
  createPasskeyService({
    store,
    clock,
    publicOrigin,
    allowedOrigins: new Set([publicOrigin, "http://127.0.0.1:7777", "https://other.example"]),
    lib,
  });
const enroll = async (passkeys = service(), id = "cred-1") => {
  const registration = await passkeys.registerOptions("u1");
  await passkeys.registerVerify("u1", registration.flowId, { id });
};
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("passkeys", () => {
  it("an IP origin disables passkeys instead of failing", async () => {
    expect(rpIdFor("http://127.0.0.1:7777")).toBeNull();
    expect(rpIdFor("http://[::1]:7777")).toBeNull();
    expect(rpIdFor("not a url")).toBeNull();
    expect(rpIdFor("https://pap.example.ts.net")).toBe("pap.example.ts.net");
    const ip = service("http://127.0.0.1:7777");
    expect(ip.available).toBe(false);
    await expect(ip.loginOptions()).rejects.toThrow(PapError);
    await expect(ip.registerOptions("u1")).rejects.toThrow(PapError);
  });

  it("registers, then signs in and stores the new counter", async () => {
    const passkeys = service();
    const registration = await passkeys.registerOptions("u1");
    await passkeys.registerVerify("u1", registration.flowId, { id: "cred-1" });
    expect(store.findPasskey("cred-1")).toMatchObject({
      userId: "u1",
      counter: 0,
      transports: ["internal"],
      publicKey: new Uint8Array([1, 2, 3]),
    });
    const login = await passkeys.loginOptions();
    expect(await passkeys.loginVerify(login.flowId, { id: "cred-1" })).toBe("u1");
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
    const registration = await passkeys.registerOptions("u1");
    await expect(passkeys.registerVerify("u2", registration.flowId, { id: "cred-1" })).rejects.toThrow(
      PapError,
    );
    await expect(passkeys.registerVerify("u1", registration.flowId, { id: "cred-1" })).rejects.toThrow(
      PapError,
    );
    expect(store.listPasskeys("u1")).toEqual([]);

    await enroll(passkeys);
    const inTime = await passkeys.loginOptions();
    await clock.advance(5 * 60_000 - 1);
    expect(await passkeys.loginVerify(inTime.flowId, { id: "cred-1" })).toBe("u1");
    const late = await passkeys.loginOptions();
    const lateRegistration = await passkeys.registerOptions("u1");
    await clock.advance(5 * 60_000 + 1);
    await expect(passkeys.loginVerify(late.flowId, { id: "cred-1", counter: 6 })).rejects.toThrow(PapError);
    await expect(passkeys.registerVerify("u1", lateRegistration.flowId, { id: "cred-2" })).rejects.toThrow(
      PapError,
    );
    expect(store.listPasskeys("u1")).toHaveLength(1);
  });

  it("does not let a registration flow log in, or a login flow register", async () => {
    const passkeys = service();
    await enroll(passkeys);
    const registration = await passkeys.registerOptions("u1");
    await expect(passkeys.loginVerify(registration.flowId, { id: "cred-1" })).rejects.toThrow(PapError);
    const login = await passkeys.loginOptions();
    await expect(passkeys.registerVerify("u1", login.flowId, { id: "cred-2" })).rejects.toThrow(PapError);
    expect(calls.verifyAuthenticationResponse).toHaveLength(0);
  });

  it("consumes a flow on its first attempt even when verification fails", async () => {
    const passkeys = service();
    const registration = await passkeys.registerOptions("u1");
    await expect(passkeys.registerVerify("u1", registration.flowId, { id: "boom" })).rejects.toThrow(
      PapError,
    );
    await expect(passkeys.registerVerify("u1", registration.flowId, { id: "cred-1" })).rejects.toThrow(
      PapError,
    );
    expect(calls.verifyRegistrationResponse).toHaveLength(1);
    expect(store.listPasskeys("u1")).toEqual([]);

    await enroll(passkeys);
    const login = await passkeys.loginOptions();
    await expect(passkeys.loginVerify(login.flowId, { id: "unknown" })).rejects.toThrow(PapError);
    await expect(passkeys.loginVerify(login.flowId, { id: "cred-1" })).rejects.toThrow(PapError);
    expect(calls.verifyAuthenticationResponse).toHaveLength(0);
  });

  it("caps pending sign-ins at 100 and never lets them evict an enrollment in progress", async () => {
    const passkeys = service();
    await enroll(passkeys);
    const registration = await passkeys.registerOptions("u1");
    const first = await passkeys.loginOptions();
    for (let i = 0; i < 99; i++) await passkeys.loginOptions();
    const newest = await passkeys.loginOptions();
    await expect(passkeys.loginVerify(first.flowId, { id: "cred-1" })).rejects.toThrow(PapError);
    expect(calls.verifyAuthenticationResponse).toHaveLength(0);
    expect(await passkeys.loginVerify(newest.flowId, { id: "cred-1" })).toBe("u1");
    // 100 login flows did not evict the enrollment in progress.
    await passkeys.registerVerify("u1", registration.flowId, { id: "cred-2" });
    expect(store.listPasskeys("u1")).toHaveLength(2);
  });

  it("caps pending enrollments at 100 too, evicting the oldest", async () => {
    const passkeys = service();
    const first = await passkeys.registerOptions("u1");
    for (let i = 0; i < 99; i++) await passkeys.registerOptions("u1");
    await passkeys.registerOptions("u1");
    await expect(passkeys.registerVerify("u1", first.flowId, { id: "cred-1" })).rejects.toThrow(PapError);
    expect(calls.verifyRegistrationResponse).toHaveLength(0);
  });

  it("refuses a credential id that is already registered and keeps the first one intact", async () => {
    const passkeys = service();
    await enroll(passkeys);
    const before = store.findPasskey("cred-1");
    const again = await passkeys.registerOptions("u1");
    expect(calls.generateRegistrationOptions[1]).toMatchObject({
      excludeCredentials: [{ id: "cred-1", transports: ["internal"] }],
    });
    const failure = await rejection(passkeys.registerVerify("u1", again.flowId, { id: "cred-1" }));
    expect(failure).toBeInstanceOf(PapError);
    expect((failure as PapError).code).toBe("conflict");
    expect(store.listPasskeys("u1")).toEqual([before]);
  });

  it("registers a passkey only for an existing user", async () => {
    const failure = await rejection(service().registerOptions("ghost"));
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
