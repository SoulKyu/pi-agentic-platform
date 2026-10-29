import { Duplex } from "node:stream";
import { type BoxRef, boxKey, PapError, type TunnelFrame } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import type { BoxTunnelChannel, BoxTunnels } from "../../kernel/boxes.ts";
import { createPreviewGrants } from "./grants.ts";
import { OTHER_BOX, PROJECT_BOX, registryBed } from "./testing/registry-bed.ts";

const OWNER = "u1";

/** A raw channel: it keeps no frame for a listener that comes late, so a socket that is not wrapped at once loses what follows. */
function channelBed() {
  let listener: ((frame: TunnelFrame) => void) | undefined;
  const sent: TunnelFrame[] = [];
  const channel: BoxTunnelChannel = {
    send: (frame) => (sent.push(frame), true),
    onFrame: (next) => void (listener = next),
    closed: new Promise<void>(() => undefined),
    close: () => undefined,
  };
  return {
    channel,
    sent,
    registered: () => listener !== undefined,
    emit: (frame: TunnelFrame) => listener?.(frame),
  };
}

async function build(options: { tunnels?: BoxTunnels | null; withRegistry?: boolean } = {}) {
  const bed = registryBed();
  bed.run(PROJECT_BOX);
  const view = await bed.registry.start(PROJECT_BOX, OWNER, bed.spec("site", 3000, true));
  const opens: Array<[BoxRef, string]> = [];
  const chan = channelBed();
  let opening: Promise<BoxTunnelChannel> = Promise.resolve(chan.channel);
  const tunnels: BoxTunnels = {
    open: (box, id) => (opens.push([box, id]), opening),
  };
  const grants = createPreviewGrants({
    tokens: bed.tokens,
    registry: options.withRegistry === false ? null : bed.registry,
    tunnels: options.tunnels === undefined ? tunnels : options.tunnels,
  });
  const mint = (id = view.id) =>
    bed.tokens.mintService({
      ownerId: OWNER,
      box: PROJECT_BOX,
      serviceId: id,
      port: 3000,
      sources: ["https://cdn.example.com"],
    }).token;
  return {
    bed,
    view,
    grants,
    opens,
    chan,
    mint,
    reopen: (next: Promise<BoxTunnelChannel>) => void (opening = next),
  };
}

describe("the listener's grants", () => {
  it("a live token of a running service is a grant with the box, the port and the frozen sources", async () => {
    const { grants, mint } = await build();
    const grant = grants.grantOf("service", mint());
    expect(grant).toMatchObject({
      kind: "service",
      box: boxKey(PROJECT_BOX),
      port: 3000,
      sources: ["https://cdn.example.com"],
    });
  });

  it("an unknown token, the other kind's token and a stale token of a stopped service are null", async () => {
    const { bed, grants, mint, view } = await build();
    const token = mint();
    expect(grants.grantOf("service", "x".repeat(43))).toBeNull();
    expect(grants.grantOf("artifact", token)).toBeNull();
    await bed.registry.stop(PROJECT_BOX, "site");
    expect(grants.grantOf("service", token)).toBeNull();
    // Even a token minted for the stopped service's id after the stop (nothing revoked it) is no grant: the state is checked.
    expect(grants.grantOf("service", mint())).toBeNull();
    // A token minted for a service the registry does not hold (or holds elsewhere) is null too.
    expect(grants.grantOf("service", mint("f".repeat(32)))).toBeNull();
    expect(bed.registry.byId(view.id)?.view.state).toBe("stopped");
  });

  it("a token of the box's other service id, or of another box, is null", async () => {
    const { bed, grants, view } = await build();
    const wrongBox = bed.tokens.mintService({
      ownerId: OWNER,
      box: { kind: "project", id: "0b1c2d3e-0000-4000-8000-000000000002" },
      serviceId: view.id,
      port: 3000,
      sources: [],
    }).token;
    expect(grants.grantOf("service", wrongBox)).toBeNull();
  });

  it("a token naming another service's id, or another owner, is null", async () => {
    const { bed, grants, view } = await build();
    bed.run(OTHER_BOX);
    const other = await bed.registry.start(OTHER_BOX, OWNER, bed.spec("other", 3001, true));
    // The id is a running service of another box, the token says this box.
    const crossed = bed.tokens.mintService({
      ownerId: OWNER,
      box: PROJECT_BOX,
      serviceId: other.id,
      port: 3001,
      sources: [],
    });
    expect(grants.grantOf("service", crossed.token)).toBeNull();
    // The right id and box, minted for someone else.
    const stranger = bed.tokens.mintService({
      ownerId: "u2",
      box: PROJECT_BOX,
      serviceId: view.id,
      port: 3000,
      sources: [],
    });
    expect(grants.grantOf("service", stranger.token)).toBeNull();
  });

  it("open() asks the box's tunnels for the service id and wraps the channel in a socket at once", async () => {
    const { grants, mint, opens, chan, view } = await build();
    const grant = grants.grantOf("service", mint());
    if (grant === null || grant.kind !== "service") throw new Error("no grant");
    const socket = await grant.open();
    expect(socket).toBeInstanceOf(Duplex);
    expect(opens).toEqual([[PROJECT_BOX, view.id]]);
    expect(chan.registered()).toBe(true);
    socket.destroy();
  });

  it("open() registers its frame listener in the turn the open resolves: a frame sent in that turn is not lost", async () => {
    const { grants, mint, chan, reopen } = await build();
    let resolveOpen: (channel: BoxTunnelChannel) => void = () => undefined;
    const pending = new Promise<BoxTunnelChannel>((resolve) => (resolveOpen = resolve));
    reopen(pending);
    const grant = grants.grantOf("service", mint());
    if (grant === null || grant.kind !== "service") throw new Error("no grant");
    const opened = grant.open();
    // The guest's first frame comes right behind the hello, in the same turn the open resolves.
    void pending.then(() =>
      chan.emit({ type: "tunnel_data", data: Buffer.from("hello").toString("base64") }),
    );
    resolveOpen(chan.channel);
    const socket = await opened;
    expect(socket.read()?.toString()).toBe("hello");
    socket.destroy();
  });

  it("open() rejects as the tunnels do (a stopped box is box_stopped)", async () => {
    const { grants, mint, reopen } = await build();
    reopen(Promise.reject(new PapError("box_stopped")));
    const grant = grants.grantOf("service", mint());
    if (grant === null || grant.kind !== "service") throw new Error("no grant");
    await expect(grant.open()).rejects.toEqual(new PapError("box_stopped"));
  });

  it("an artifact token is the html; with no VM stack artifacts are served and services are not", async () => {
    const { bed, grants } = await build({ withRegistry: false, tunnels: null });
    const { token } = bed.tokens.mintArtifact({
      ownerId: OWNER,
      sessionId: "s",
      entryId: "e",
      fenceIndex: 0,
      html: "<p>x</p>",
    });
    expect(grants.grantOf("artifact", token)).toEqual({ kind: "artifact", html: "<p>x</p>" });
    expect(grants.grantOf("service", token)).toBeNull();
    const service = bed.tokens.mintService({
      ownerId: OWNER,
      box: PROJECT_BOX,
      serviceId: "a".repeat(32),
      port: 3000,
      sources: [],
    });
    expect(grants.grantOf("service", service.token)).toBeNull();
  });

  it("the listener touches the box: onTraffic maps the box key to the runtime's touch", async () => {
    const { bed } = await build();
    const touched: BoxRef[] = [];
    const grants = createPreviewGrants({
      tokens: bed.tokens,
      registry: bed.registry,
      tunnels: null,
      touch: (box) => touched.push(box),
    });
    grants.onTraffic(boxKey(PROJECT_BOX));
    grants.onTraffic("garbage");
    expect(touched).toEqual([PROJECT_BOX]);
  });
});
