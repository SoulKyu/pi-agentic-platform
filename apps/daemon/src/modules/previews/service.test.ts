import { type BoxRef, type Caller, type Permission, PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createPreviewsService, type PreviewsServiceDeps } from "./service.ts";
import { AGENT_BOX, OTHER_BOX, PROJECT_BOX, registryBed } from "./testing/registry-bed.ts";

const OWNER = "u1";
const ORIGIN = "http://localhost:9999";
const caller = (
  userId = OWNER,
  permissions: Permission[] = ["sessions:operate", "agents:operate"],
): Caller => ({
  userId,
  permissions: new Set(permissions),
  kind: "session",
  credentialId: "c",
  stepUpUntil: 0,
});
const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "ok";
  } catch (error) {
    return error instanceof PapError ? error.code : "threw";
  }
};

function build(over: Partial<PreviewsServiceDeps> = {}) {
  const bed = registryBed();
  bed.run(PROJECT_BOX);
  bed.run(AGENT_BOX);
  const config = vi.fn<PreviewsServiceDeps["projectConfig"]>(async () => ({
    preview: { command: "npm run dev", port: 5173 },
    previewInvalid: false,
  }));
  const entryText = vi.fn<PreviewsServiceDeps["entryText"]>(async () => null);
  const service = createPreviewsService({
    registry: bed.registry,
    tokens: bed.tokens,
    origin: ORIGIN,
    ownerOf: (box: BoxRef) =>
      box.kind === "project" && box.id === PROJECT_BOX.id
        ? OWNER
        : box.kind === "agent" && box.id === AGENT_BOX.id
          ? OWNER
          : box.kind === "project" && box.id === OTHER_BOX.id
            ? "u2"
            : null,
    phase: (box) => bed.runtime.phase(box),
    hostsOf: () => ["cdn.example.com"],
    ownHosts: () => ["localhost"],
    projectConfig: config,
    entryText,
    logger: silentLogger,
    ...over,
  });
  return { bed, service, config, entryText };
}

describe("the permission table per box kind", () => {
  it("a project box needs sessions:operate, an agent box agents:operate, each for every call", async () => {
    const { bed, service } = build();
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    await bed.registry.start(AGENT_BOX, OWNER, bed.spec("site"));
    const calls = (box: BoxRef) => ({
      list: (c: Caller) => service.list(c, box),
      stop: (c: Caller) => service.stop(c, box, "site"),
      restart: (c: Caller) => service.restart(c, box, "site"),
      logs: (c: Caller) => service.logs(c, box, "site"),
      open: (c: Caller) => service.open(c, box, "site"),
    });
    for (const [box, held, other] of [
      [PROJECT_BOX, "sessions:operate", "agents:operate"],
      [AGENT_BOX, "agents:operate", "sessions:operate"],
    ] as const)
      for (const [name, call] of Object.entries(calls(box))) {
        expect(await codeOf(call(caller(OWNER, [other]))), `${box.kind} ${name} without ${held}`).toBe(
          "forbidden",
        );
        expect(await codeOf(call(caller(OWNER, []))), `${box.kind} ${name} with nothing`).toBe("forbidden");
        expect(await codeOf(call(caller(OWNER, [held]))), `${box.kind} ${name} with ${held}`).toBe("ok");
      }
  });

  it("another owner's box and an unknown box are not_found, for every call", async () => {
    const { service } = build();
    const unknown: BoxRef = { kind: "project", id: "0b1c2d3e-0000-4000-8000-0000000000ff" };
    for (const box of [OTHER_BOX, unknown]) {
      expect(await codeOf(service.list(caller(), box))).toBe("not_found");
      expect(await codeOf(service.stop(caller(), box, "site"))).toBe("not_found");
      expect(await codeOf(service.restart(caller(), box, "site"))).toBe("not_found");
      expect(await codeOf(service.logs(caller(), box, "site"))).toBe("not_found");
      expect(await codeOf(service.open(caller(), box, "site"))).toBe("not_found");
    }
    expect(
      await codeOf(service.startProject(caller(), { projectId: OTHER_BOX.id, command: "x", port: 5173 })),
    ).toBe("not_found");
  });
});

describe("list, stop, restart, logs", () => {
  it("list answers the registry's services with their box, and the registry's own when the guest cannot be asked", async () => {
    const { bed, service } = build();
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    const listed = await service.list(caller(), PROJECT_BOX);
    expect(listed.services).toEqual([
      expect.objectContaining({ name: "site", box: PROJECT_BOX, state: "running" }),
    ]);
    bed.failNext(new PapError("timeout"));
    expect((await service.list(caller(), PROJECT_BOX)).services).toHaveLength(1);
  });

  it("stop of a name the box does not hold is not_found; of a held one stops it", async () => {
    const { bed, service } = build();
    expect(await codeOf(service.stop(caller(), PROJECT_BOX, "site"))).toBe("not_found");
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    await service.stop(caller(), PROJECT_BOX, "site");
    expect(bed.registry.list(PROJECT_BOX)[0]?.state).toBe("stopped");
  });

  it("restart answers the new service with its box; logs answer the registry's redacted lines", async () => {
    const { bed, service } = build();
    const first = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    const again = await service.restart(caller(), PROJECT_BOX, "site");
    expect(again.service).toMatchObject({ name: "site", box: PROJECT_BOX });
    expect(again.service.id).not.toBe(first.id);
    bed.guest(PROJECT_BOX).logs.set("site", ["one", "two"]);
    expect(await service.logs(caller(), PROJECT_BOX, "site")).toEqual({ lines: ["one", "two"] });
  });

  it("without a VM stack the list is empty and every other call is box_stopped (PF-10), a missing permission still forbidden", async () => {
    const { service } = build({ registry: null });
    expect(await service.list(caller(), PROJECT_BOX)).toEqual({ services: [] });
    expect(await codeOf(service.list(caller(OWNER, []), PROJECT_BOX))).toBe("forbidden");
    expect(await codeOf(service.open(caller(), PROJECT_BOX, "site"))).toBe("box_stopped");
    expect(await codeOf(service.stop(caller(), PROJECT_BOX, "site"))).toBe("box_stopped");
    expect(
      await codeOf(
        service.startProject(caller(), { projectId: PROJECT_BOX.id, command: "npm run dev", port: 5173 }),
      ),
    ).toBe("box_stopped");
  });
});

describe("open", () => {
  it("mints a lease on the preview origin: /p/<token>/, 5 minutes, the daemon's network and hosts", async () => {
    const { bed, service } = build();
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site", 3000, false));
    const closed = await service.open(caller(), PROJECT_BOX, "site");
    expect(closed.url).toMatch(/^http:\/\/localhost:9999\/p\/[A-Za-z0-9_-]{43}\/$/);
    expect(closed.lease).toMatch(/^[0-9a-f]{32}$/);
    expect(closed.leaseMs).toBe(300_000);
    const token = closed.url.split("/")[4] ?? "";
    // No network: no host source at all.
    expect(bed.tokens.resolve("service", token)).toMatchObject({ sources: [], port: 3000 });
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("net", 3001, true));
    const opened = await service.open(caller(), PROJECT_BOX, "net");
    const grant = bed.tokens.resolve("service", opened.url.split("/")[4] ?? "");
    expect(grant).toMatchObject({ kind: "service", port: 3001 });
    expect((grant as unknown as { sources: string[] }).sources).toContain("https://cdn.example.com");
  });

  it("freezes the list at mint: a later change shows only in the next open", async () => {
    let hosts = ["one.example.com"];
    const { bed, service } = build({ hostsOf: () => hosts });
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site", 3000, true));
    const first = await service.open(caller(), PROJECT_BOX, "site");
    hosts = ["one.example.com", "two.example.com"];
    const second = await service.open(caller(), PROJECT_BOX, "site");
    const sourcesOf = (url: string) =>
      (bed.tokens.resolve("service", url.split("/")[4] ?? "") as unknown as { sources: string[] }).sources;
    expect(sourcesOf(first.url).join()).not.toContain("two.example.com");
    expect(sourcesOf(second.url).join()).toContain("two.example.com");
  });

  it("never admits pap's own hosts into the sources", async () => {
    const { bed, service } = build({ hostsOf: () => ["localhost", "cdn.example.com"] });
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site", 3000, true));
    const opened = await service.open(caller(), PROJECT_BOX, "site");
    const sources = (
      bed.tokens.resolve("service", opened.url.split("/")[4] ?? "") as unknown as { sources: string[] }
    ).sources;
    expect(sources.join()).not.toContain("localhost");
    expect(sources.join()).toContain("cdn.example.com");
  });

  it("is not_found for a held service that is not running and for an unknown name; unavailable only without a listener", async () => {
    const { bed, service } = build();
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    expect(await codeOf(service.open(caller(), PROJECT_BOX, "nope"))).toBe("not_found");
    await service.stop(caller(), PROJECT_BOX, "site");
    expect(await codeOf(service.open(caller(), PROJECT_BOX, "site"))).toBe("not_found");
    const off = build({ origin: null });
    await off.bed.registry.start(PROJECT_BOX, OWNER, off.bed.spec("site"));
    expect(await codeOf(off.service.open(caller(), PROJECT_BOX, "site"))).toBe("unavailable");
  });

  it("an unknown name on a stopped box is box_stopped", async () => {
    const { bed, service } = build();
    bed.halt(PROJECT_BOX);
    expect(await codeOf(service.open(caller(), PROJECT_BOX, "site"))).toBe("box_stopped");
  });
});

describe("renew and close", () => {
  it("renew of another owner's lease is not_found and an unknown lease the same; the owner's gets a new end", async () => {
    const { bed, service } = build();
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    const { lease } = await service.open(caller(), PROJECT_BOX, "site");
    expect(await codeOf(service.renew(caller("u2"), lease))).toBe("not_found");
    expect(await codeOf(service.renew(caller(), "00".repeat(16)))).toBe("not_found");
    await bed.clock.advance(60_000);
    const renewed = await service.renew(caller(), lease);
    expect(renewed.until).toBe(bed.clock.now() + 300_000);
  });

  it("close kills the caller's lease and its token; another owner's lease and an unknown one answer the same, silently", async () => {
    const { bed, service } = build();
    await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site"));
    const { lease, url } = await service.open(caller(), PROJECT_BOX, "site");
    const token = url.split("/")[4] ?? "";
    await expect(service.close(caller("u2"), lease)).resolves.toBeUndefined();
    expect(bed.tokens.resolve("service", token)).not.toBeNull();
    await expect(service.close(caller(), "00".repeat(16))).resolves.toBeUndefined();
    await expect(service.close(caller(), lease)).resolves.toBeUndefined();
    expect(bed.tokens.resolve("service", token)).toBeNull();
  });
});

describe("artifact", () => {
  const reply = "intro\n```html\n<p>one</p>\n```\n```js\nlet x\n```\n```html\n<p>two</p>\n```\n";

  it("reads the entry through the sessions, takes the fence by index and serves its body from /a/<token>/", async () => {
    const { bed, service, entryText } = build();
    entryText.mockResolvedValue(reply);
    const minted = await service.artifact(caller(), { sessionId: "s1", entryId: "e1", fenceIndex: 2 });
    expect(entryText).toHaveBeenCalledWith("s1", "e1", expect.objectContaining({ userId: OWNER }));
    expect(minted.url).toMatch(/^http:\/\/localhost:9999\/a\/[A-Za-z0-9_-]{43}\/$/);
    expect(bed.tokens.resolve("artifact", minted.url.split("/")[4] ?? "")).toMatchObject({
      html: "<p>two</p>",
      entryId: "e1",
      fenceIndex: 2,
      sessionId: "s1",
      ownerId: OWNER,
    });
    expect(minted.until).toBe(bed.clock.now() + 3_600_000);
  });

  it("a fence that is not html, an index past the fences and a missing entry are not_found", async () => {
    const { service, entryText } = build();
    entryText.mockResolvedValue(reply);
    expect(await codeOf(service.artifact(caller(), { sessionId: "s1", entryId: "e1", fenceIndex: 1 }))).toBe(
      "not_found",
    );
    expect(await codeOf(service.artifact(caller(), { sessionId: "s1", entryId: "e1", fenceIndex: 9 }))).toBe(
      "not_found",
    );
    entryText.mockResolvedValue(null);
    expect(
      await codeOf(service.artifact(caller(), { sessionId: "s1", entryId: "gone", fenceIndex: 0 })),
    ).toBe("not_found");
  });

  it("a session that is not the caller's is whatever the sessions answer (not_found), and nothing is minted", async () => {
    const { bed, service, entryText } = build();
    entryText.mockRejectedValue(new PapError("not_found"));
    expect(
      await codeOf(service.artifact(caller("u2"), { sessionId: "s1", entryId: "e1", fenceIndex: 0 })),
    ).toBe("not_found");
    expect(bed.tokens.revokeOwner("u2")).toBe(0);
  });

  it("is unavailable without a listener, before anything is read; 256 KiB of html is the most", async () => {
    const off = build({ origin: null });
    expect(
      await codeOf(off.service.artifact(caller(), { sessionId: "s1", entryId: "e1", fenceIndex: 0 })),
    ).toBe("unavailable");
    expect(off.entryText).not.toHaveBeenCalled();
    const { service, entryText } = build();
    entryText.mockResolvedValue(`\`\`\`html\n${"x".repeat(256 * 1024 + 1)}\n\`\`\`\n`);
    expect(await codeOf(service.artifact(caller(), { sessionId: "s1", entryId: "e1", fenceIndex: 0 }))).toBe(
      "payload_too_large",
    );
  });
});

describe("startProject (UX2-R36, R74)", () => {
  const asked = { projectId: PROJECT_BOX.id, command: "npm run dev", port: 5173 };

  it("starts the service project with the daemon's network true, from the declaration read fresh", async () => {
    const { bed, service, config } = build();
    const started = await service.startProject(caller(), asked);
    expect(config).toHaveBeenCalledWith(PROJECT_BOX.id);
    expect(started.service).toMatchObject({ name: "project", port: 5173, network: true, box: PROJECT_BOX });
    const call = bed.calls.find((entry) => entry.op.name === "svc.start");
    expect(call?.op).toMatchObject({
      name: "svc.start",
      service: "project",
      command: "npm run dev",
      port: 5173,
      network: true,
    });
  });

  it("is bad_request without a valid preview, and conflict (nothing started) when the file changed since the page", async () => {
    const { bed, service, config } = build();
    config.mockResolvedValueOnce({ preview: null, previewInvalid: false });
    expect(await codeOf(service.startProject(caller(), asked))).toBe("bad_request");
    config.mockResolvedValueOnce({ preview: null, previewInvalid: true });
    expect(await codeOf(service.startProject(caller(), asked))).toBe("bad_request");
    config.mockResolvedValueOnce({ preview: { command: "rm -rf /", port: 5173 }, previewInvalid: false });
    expect(await codeOf(service.startProject(caller(), asked))).toBe("conflict");
    config.mockResolvedValueOnce({ preview: { command: "npm run dev", port: 5174 }, previewInvalid: false });
    expect(await codeOf(service.startProject(caller(), asked))).toBe("conflict");
    expect(bed.calls.filter((entry) => entry.op.name === "svc.start")).toEqual([]);
  });

  it("a box that is not running answers box_stopped, and a caller without sessions:operate is forbidden", async () => {
    const { bed, service, config } = build();
    config.mockRejectedValueOnce(new PapError("box_stopped"));
    expect(await codeOf(service.startProject(caller(), asked))).toBe("box_stopped");
    expect(await codeOf(service.startProject(caller(OWNER, ["agents:operate"]), asked))).toBe("forbidden");
    expect(bed.registry.list(PROJECT_BOX)).toEqual([]);
  });
});
