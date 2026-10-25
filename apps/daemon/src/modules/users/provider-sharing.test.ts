import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AvailableModels, Caller, ModelsOverview, Role } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { authKindOf, createProviderKinds } from "./auth-kinds.ts";
import { createProviderGate } from "./provider-gate.ts";
import { createProviderSharing } from "./provider-sharing.ts";
import { createProvidersAdmin, providersRpc } from "./providers-admin.ts";
import { USERS_MIGRATIONS } from "./index.ts";

type Auth = ModelsOverview["providers"][number]["auth"];
const auth = (over: Partial<Auth> = {}): Auth => ({
  oauthLabel: null,
  apiKey: false,
  configured: false,
  stored: null,
  status: "known",
  env: [],
  ...over,
});
const roles: Record<string, Role> = { owner1: "owner", member1: "member" };
const caller = (userId: string): Caller => ({
  userId,
  permissions: new Set(),
  kind: "session",
  credentialId: "t",
  stepUpUntil: 0,
});

let dir: string;
let db: Db;
let providers: Array<{ id: string; name: string; auth: Auth }>;
let overview: Mock<() => Promise<unknown>>;
const model = (provider: string) => ({ provider, id: `${provider}-1`, name: provider, reasoning: false });
const available = (names: string[]): AvailableModels => ({
  models: names.map(model),
  providers: names.map((id) => ({ id, name: id })),
  providerIds: names,
  origin: "scope",
  truncated: false,
});
let availableCall: Mock<(caller: Caller) => Promise<AvailableModels>>;

function build() {
  const clock = createFakeClock();
  const sharing = createProviderSharing({ db, roleOf: (id) => roles[id] ?? null });
  const kinds = createProviderKinds({
    overview: () => overview() as Promise<ModelsOverview>,
    clock,
    logger: silentLogger,
    onSeen: (provider, kind) => void sharing.stateOf(provider, kind),
  });
  const gate = createProviderGate({
    roleOf: (id) => roles[id] ?? null,
    sharing,
    kinds,
    models: () => ({ available: availableCall }),
  });
  const refresh = vi.fn();
  const admin = createProvidersAdmin({ sharing, kinds, refresh });
  return { sharing, kinds, gate, admin, refresh, clock };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-sharing-"));
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, USERS_MIGRATIONS],
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;
  providers = [];
  overview = vi.fn(async () => ({
    providers: providers.map((p) => ({ ...p, origin: "builtin", models: [], modelsTruncated: false })),
  }));
  availableCall = vi.fn(async () => available(providers.map((p) => p.id)));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("shared providers", () => {
  it("an unshared api-key provider leaves the member's policy models and pickers", async () => {
    providers = [
      { id: "acme", name: "Acme", auth: auth({ stored: "api_key" }) },
      { id: "beta", name: "Beta", auth: auth({ stored: "api_key" }) },
    ];
    const { gate, admin } = build();
    // An API key is shared by default; the owner switches one off.
    expect(await gate.filter("member1", [model("acme"), model("beta")])).toHaveLength(2);
    await admin.setShared("beta", false);
    expect((await gate.filter("member1", [model("acme"), model("beta")])).map((m) => m.provider)).toEqual([
      "acme",
    ]);
    expect((await gate.available(caller("member1"))).models.map((m) => m.provider)).toEqual(["acme"]);
    expect((await gate.available(caller("member1"))).providerIds).toEqual(["acme"]);
    expect(
      (
        await gate.sessionModels("member1", {
          models: [model("acme"), model("beta")],
          truncated: false,
          current: { provider: "beta", id: "beta-1" },
        })
      ).current,
    ).toBeNull();
    // The owner sees everything, and an unknown id nothing.
    expect(await gate.filter("owner1", [model("acme"), model("beta")])).toHaveLength(2);
    expect(await gate.filter("ghost", [model("acme")])).toEqual([]);
  });

  it("a provider that moves from OAuth to an API key stays unshared", async () => {
    providers = [{ id: "acme", name: "Acme", auth: auth({ stored: "oauth" }) }];
    const { gate, kinds } = build();
    expect(await gate.filter("member1", [model("acme")])).toEqual([]);
    providers = [{ id: "acme", name: "Acme", auth: auth({ stored: "api_key" }) }];
    kinds.reset();
    expect(await gate.filter("member1", [model("acme")])).toEqual([]);
    // A provider first seen with a key is shared by default.
    providers.push({ id: "fresh", name: "Fresh", auth: auth({ stored: "api_key" }) });
    kinds.reset();
    expect(await gate.filter("member1", [model("fresh")])).toHaveLength(1);
  });

  it("a provider first seen on a subscription stays unshared after it moves to an API key, with no member call between (RT-16)", async () => {
    providers = [{ id: "acme", name: "Acme", auth: auth({ stored: "oauth" }) }];
    const { gate, kinds, sharing } = build();
    await kinds.get();
    expect(sharing.list()).toEqual([{ provider: "acme", shared: false }]);
    providers = [{ id: "acme", name: "Acme", auth: auth({ stored: "api_key" }) }];
    gate.reset();
    await kinds.get();
    expect(await gate.filter("member1", [model("acme")])).toEqual([]);
  });

  it("a provider with no known auth is not shared and leaves no row", async () => {
    providers = [{ id: "acme", name: "Acme", auth: auth() }];
    const { gate, sharing } = build();
    expect(await gate.filter("member1", [model("acme")])).toEqual([]);
    expect(sharing.list()).toEqual([]);
  });

  it("a models.json literal key and a $VAR key count as api_key", () => {
    expect(authKindOf(auth({ configured: true, apiKey: true }))).toBe("api_key");
    expect(authKindOf(auth({ stored: "api_key", configured: true }))).toBe("api_key");
    expect(authKindOf(auth({ env: [{ name: "ACME_API_KEY", set: true }] }))).toBe("api_key");
    expect(authKindOf(auth({ env: [{ name: "ACME_OAUTH_TOKEN", set: true }] }))).toBeNull();
    expect(authKindOf(auth({ stored: "oauth" }))).toBe("oauth");
    expect(authKindOf(auth({ status: "unknown", configured: true }))).toBeNull();
    expect(authKindOf(auth())).toBeNull();
  });

  it("claude-bridge is never filtered by sharing", async () => {
    const { gate, sharing } = build();
    expect(await gate.filter("member1", [model("claude-bridge")])).toHaveLength(1);
    expect(sharing.sharedFor("member1", "claude-bridge", null)).toBe(true);
    expect(sharing.list()).toEqual([]);
  });

  it("sessions.availableModels names no cwd", async () => {
    providers = [{ id: "acme", name: "Acme", auth: auth({ stored: "api_key" }) }];
    const { gate } = build();
    await gate.available(caller("member1"));
    expect(availableCall).toHaveBeenCalledTimes(1);
    expect(availableCall.mock.calls[0]).toHaveLength(1);
  });

  it("a subscription provider cannot be shared", async () => {
    providers = [{ id: "anthropic", name: "Anthropic", auth: auth({ stored: "oauth" }) }];
    const { admin, refresh } = build();
    await expect(admin.setShared("anthropic", true)).rejects.toMatchObject({ code: "bad_request" });
    await expect(admin.setShared("claude-bridge", true)).rejects.toMatchObject({ code: "bad_request" });
    await expect(admin.setShared("nothing", true)).rejects.toMatchObject({ code: "not_found" });
    expect(refresh).not.toHaveBeenCalled();
    expect(await admin.list()).toEqual([
      { provider: "anthropic", label: "Anthropic", auth: "oauth", shared: false, servable: false },
    ]);
  });

  it("setProviderShared refreshes the relay", async () => {
    providers = [{ id: "acme", name: "Acme", auth: auth({ stored: "api_key" }) }];
    const { admin, refresh, sharing } = build();
    const append = vi.fn();
    const rpc = providersRpc(admin, { append });
    const ctx = { caller: caller("owner1") } as never;
    expect(await rpc["users.setProviderShared"]({ provider: "acme", shared: false }, ctx)).toEqual({
      ok: true,
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner1",
        reason: "provider_sharing_set",
        detail: { provider: "acme", shared: false },
      }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sharing.list()).toEqual([{ provider: "acme", shared: false }]);
    expect((await rpc["users.providers"]({}, {} as never)).providers).toEqual([
      { provider: "acme", label: "Acme", auth: "api_key", shared: false, servable: true },
    ]);
  });

  it("reads the overview once, and again after a reset", async () => {
    providers = [{ id: "acme", name: "Acme", auth: auth({ stored: "api_key" }) }];
    const { gate, kinds } = build();
    await gate.filter("member1", [model("acme")]);
    await gate.filter("member1", [model("acme")]);
    await gate.filter("owner1", [model("acme")]);
    expect(overview).toHaveBeenCalledTimes(1);
    kinds.reset();
    await gate.filter("member1", [model("acme")]);
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it("shares nothing new when the overview cannot be read", async () => {
    overview.mockRejectedValueOnce(new Error("helper busy"));
    const { gate } = build();
    expect(await gate.filter("member1", [model("acme")])).toEqual([]);
  });
});
