import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_BUNDLE_DIR, renderDockerfile } from "../apps/vmd/src/dockerfile.ts";
import { BUNDLE_ROOT } from "../apps/vmd/src/ops.ts";
import { putAgentBundle } from "./agent-bundle-fixture.ts";
import { AGENT_BUNDLE, REQUIRED_FILES } from "./build-agent-bundle.ts";

/*
 * J1b item 5 (ledger line 264). The base image is built with the bundle folder AS the build context (`copyContext` copies
 * `BUNDLE_ROOT`, which `pap vm setup` fills from `AGENT_BUNDLE`). Mutants, run for real: the Dockerfile COPYs `pap/` again
 * (a folder the bundle never had) -> "every COPY source of the base layer is in the bundle" fails; the entrypoint names a
 * path the bundle does not hold -> "the entrypoint is a file of the bundle" fails.
 */
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function bundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "pap-bundle-image-"));
  roots.push(dir);
  putAgentBundle(join(dir, "bundle"));
  return join(dir, "bundle");
}
const base = {
  op: "image.build" as const,
  layer: "base" as const,
  tag: `pap-agent-base-${"1".repeat(64)}`,
  from: `docker.io/library/node@sha256:${"9".repeat(64)}`,
  aptPackages: [],
  upgrade: false,
};
const lines = renderDockerfile(base).split("\n");
const copies = lines.flatMap((line) => {
  const match = /^COPY (\S+) (\S+)$/.exec(line);
  return match ? [{ src: match[1] as string, dst: match[2] as string }] : [];
});
const entrypoint = /^ENTRYPOINT \["[^"]+", "([^"]+)"\]$/.exec(
  lines.find((l) => l.startsWith("ENTRYPOINT")) ?? "",
)?.[1];

describe("the agent bundle and the base Dockerfile (J1b)", () => {
  it("builds the base layer from the bundle root, which setup fills from the pi-host bundle", () => {
    expect(BUNDLE_ROOT).toBe("/opt/pap-vm/agent-bundle");
    expect(AGENT_BUNDLE).toBe("packages/pi-host/dist-agent");
  });

  it("every COPY source of the base layer is in the bundle", () => {
    const folder = bundle();
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) expect(existsSync(join(folder, copy.src)), `COPY ${copy.src}`).toBe(true);
  });

  it("the entrypoint is a file of the bundle, at the place the COPY puts it", () => {
    const folder = bundle();
    const copy = copies.find((one) => one.dst === `${BASE_BUNDLE_DIR}/`);
    expect(copy, "the bundle COPY").toBeDefined();
    const inImage = posix.relative(BASE_BUNDLE_DIR, entrypoint ?? "");
    expect(inImage.startsWith("..")).toBe(false);
    expect(inImage).toBe(REQUIRED_FILES[0]);
    expect(existsSync(join(folder, copy?.src ?? "", inImage))).toBe(true);
  });
});
