import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VmdFailure } from "./errors.ts";
import { renderDockerfile } from "./dockerfile.ts";
import type { ImageBuildRequest } from "./ops.ts";
import type { ExecHandler } from "./testing/fake-exec.ts";
import { createFixture, type Fixture } from "./testing/ops-fixture.ts";

/*
 * Mutants (RT-43) killed here, run for real:
 *  - M-base-from-papHome: the base layer's context is `$PAP_HOME/vm/build/base` (the user's tree), not the root-owned bundle
 *    (AVM-E31, R19): killed by "a base build copies the root-owned bundle, never $PAP_HOME's folder".
 *  - M-no-safe-copy: the context is the source folder itself, not pap-vmd's copy: killed by "the context is pap-vmd's own
 *    copy under the state folder".
 *  - M-dockerfile-in-context: the Dockerfile is written into the context: killed by "the Dockerfile is never inside the context".
 *  - M-base-cached: a base build without `--no-cache`: killed by "a base build has --no-cache and the others do not".
 *  - M-prune-running: `image.prune` removes an image a container uses: killed by "image.prune keeps the given tags and the
 *    images of existing containers".
 *  - M-no-join: a second build of a tag already building runs again: killed by "a second build of the same tag joins".
 */
const DIGEST = `docker.io/library/node@sha256:${"9".repeat(64)}`;
const tag = (layer: string, n: string): string => `pap-agent-${layer}-${n.repeat(64)}`;
const build = (
  layer: "base" | "profile" | "agent",
  extra: Partial<ImageBuildRequest> = {},
): ImageBuildRequest => ({
  op: "image.build",
  layer,
  tag: tag(layer, "1"),
  from: layer === "base" ? DIGEST : tag("base", "2"),
  aptPackages: [],
  upgrade: false,
  ...extra,
});
const isBuild = (argv: readonly string[]): boolean => argv[0]?.endsWith("/buildctl") === true;

let fx: Fixture;
const use = (handler?: ExecHandler): void => {
  if ((fx as Fixture | undefined) !== undefined) fx.cleanup();
  fx = createFixture(handler);
};
afterEach(() => fx.cleanup());
const put = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
/** What the build saw: the context and the Dockerfile folder as they were while buildctl ran. */
interface Seen {
  context: string;
  dockerfileDir: string;
  contextFiles: string[];
  dockerfile: string;
  marker: string;
}
let seen: Seen | null;
const watch: ExecHandler = (argv) => {
  if (isBuild(argv)) {
    const context = argv[argv.indexOf("--local") + 1]?.replace("context=", "") ?? "";
    const dockerfileDir = argv[argv.lastIndexOf("--local") + 1]?.replace("dockerfile=", "") ?? "";
    seen = {
      context,
      dockerfileDir,
      contextFiles: readdirSync(context),
      dockerfile: readFileSync(path.join(dockerfileDir, "Dockerfile"), "utf8"),
      marker: existsSync(path.join(context, "marker"))
        ? readFileSync(path.join(context, "marker"), "utf8")
        : "",
    };
  }
  return undefined;
};

describe("image.build", () => {
  beforeEach(() => {
    seen = null;
    use(watch);
  });

  it("a base build copies the root-owned bundle, never $PAP_HOME's folder", async () => {
    put(path.join(fx.bundle, "marker"), "bundle");
    put(path.join(fx.bundle, "pap", "pi-host", "dist", "guest", "main.js"), "//");
    put(path.join(fx.papHome, "vm", "build", "base", "marker"), "user tree");
    await expect(fx.ops.handle(build("base"))).resolves.toEqual({ tag: tag("base", "1") });
    expect(seen?.marker).toBe("bundle");
    expect(seen?.contextFiles.sort()).toEqual(["marker", "pap"]);
  });

  it("a base build has --no-cache and the others do not", async () => {
    put(path.join(fx.bundle, "marker"), "bundle");
    put(path.join(fx.papHome, "vm", "build", "profile", "pi-agent", "x"), "x");
    await fx.ops.handle(build("base"));
    await fx.ops.handle(build("profile"));
    await fx.ops.handle(build("agent", { aptPackages: ["tree"] }));
    const builds = fx.exec.calls.filter(isBuild);
    expect(builds.map((argv) => argv.includes("--no-cache"))).toEqual([true, false, false]);
    expect(builds[0]?.slice(0, 6)).toEqual([
      "/opt/pap-vm/bin/buildctl",
      "--addr",
      "unix:///run/pap-vm/buildkit.sock",
      "build",
      "--frontend",
      "dockerfile.v0",
    ]);
  });

  it("the context is pap-vmd's own copy under the state folder, the Dockerfile is never inside it", async () => {
    put(path.join(fx.papHome, "vm", "build", "profile", "pi-agent", "settings.json"), "{}");
    const request = build("profile");
    await fx.ops.handle(request);
    expect(seen?.context).toBe(fx.state.buildDir("profile"));
    expect(seen?.contextFiles).toEqual(["pi-agent"]);
    expect(seen?.dockerfileDir).toBe(fx.state.dockerfileDir("profile"));
    expect(path.relative(seen?.context ?? "", seen?.dockerfileDir ?? "").startsWith("..")).toBe(true);
    expect(seen?.dockerfile).toBe(renderDockerfile(request));
  });

  it("profile and agent contexts come from $PAP_HOME/vm/build/<layer>; a missing profile folder is not_found, a missing agent folder is an empty context", async () => {
    await expect(fx.ops.handle(build("profile"))).rejects.toMatchObject({ code: "not_found" });
    expect(fx.exec.calls).toEqual([]);
    await fx.ops.handle(build("agent", { aptPackages: ["tree"] }));
    expect(seen?.contextFiles).toEqual([]);
  });

  it("a link in the source stops the build (bad_request) before buildctl runs", async () => {
    mkdirSync(path.join(fx.papHome, "vm", "build"), { recursive: true });
    symlinkSync(fx.work, path.join(fx.papHome, "vm", "build", "profile"));
    await expect(fx.ops.handle(build("profile"))).rejects.toMatchObject({ code: "bad_request" });
    expect(fx.exec.calls).toEqual([]);
  });

  it("a failed build is failed, and the copy of the context is removed after any build", async () => {
    put(path.join(fx.papHome, "vm", "build", "profile", "pi-agent", "x"), "x");
    await fx.ops.handle(build("profile"));
    expect(existsSync(fx.state.buildDir("profile"))).toBe(false);
    use((argv) => (isBuild(argv) ? { code: 1 } : undefined));
    put(path.join(fx.papHome, "vm", "build", "profile", "pi-agent", "x"), "x");
    await expect(fx.ops.handle(build("profile"))).rejects.toMatchObject({ code: "failed" });
    expect(existsSync(fx.state.buildDir("profile"))).toBe(false);
  });

  it("disk_low refuses before copying", async () => {
    put(path.join(fx.bundle, "marker"), "bundle");
    fx.room = () => Promise.reject(new VmdFailure("disk_low"));
    await expect(fx.ops.handle(build("base"))).rejects.toMatchObject({ code: "disk_low" });
    expect(existsSync(fx.state.buildDir("base"))).toBe(false);
  });

  it("a second build of the same tag joins the one running", async () => {
    put(path.join(fx.bundle, "marker"), "bundle");
    const results = await Promise.all([fx.ops.handle(build("base")), fx.ops.handle(build("base"))]);
    expect(results[0]).toEqual(results[1]);
    expect(fx.exec.calls.filter(isBuild)).toHaveLength(1);
  });
});

describe("image.list and image.prune", () => {
  const A = tag("agent", "a");
  const B = tag("agent", "b");
  const C = tag("profile", "c");
  const images = [
    `pap.local/${A}:1`,
    `pap.local/${B}:1`,
    `pap.local/${C}:1`,
    "docker.io/library/node:latest",
    "<none>:<none>",
  ];
  const handler: ExecHandler = (argv) =>
    argv.includes("images") ? { stdout: images.join("\n") + "\n" } : undefined;

  beforeEach(() => use(handler));

  it("lists the pap image tags only", async () => {
    await expect(fx.ops.handle({ op: "image.list" })).resolves.toEqual({ tags: [A, B, C].sort() });
    expect(fx.exec.calls[0]?.slice(-3)).toEqual(["images", "--format", "{{.Repository}}:{{.Tag}}"]);
  });

  it("image.prune keeps the given tags and the images of existing containers", async () => {
    use((argv) => {
      if (argv.includes("images")) return handler(argv);
      if (argv.includes("ps") && argv.includes("{{.Image}}")) return { stdout: `pap.local/${B}:1\n` };
      return undefined;
    });
    await expect(fx.ops.handle({ op: "image.prune", keep: [A] })).resolves.toEqual({ removed: [C] });
    expect(fx.exec.calls.filter((argv) => argv.includes("rmi")).map((argv) => argv.at(-1))).toEqual([
      `pap.local/${C}:1`,
    ]);
  });

  it("a failing listing is failed and removes nothing", async () => {
    use((argv) => (argv.includes("images") ? { code: 1 } : undefined));
    await expect(fx.ops.handle({ op: "image.prune", keep: [] })).rejects.toMatchObject({ code: "failed" });
    expect(fx.exec.calls.some((argv) => argv.includes("rmi"))).toBe(false);
  });
});
