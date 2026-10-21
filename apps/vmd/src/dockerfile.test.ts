import { describe, expect, it } from "vitest";
import { renderDockerfile } from "./dockerfile.ts";
import type { ImageBuildRequest } from "./ops.ts";

const DIGEST = `docker.io/library/node@sha256:${"9".repeat(64)}`;
const base = (extra: Partial<ImageBuildRequest> = {}): ImageBuildRequest => ({
  op: "image.build",
  layer: "base",
  tag: `pap-agent-base-${"1".repeat(64)}`,
  from: DIGEST,
  aptPackages: [],
  upgrade: false,
  ...extra,
});
const BASE_TAG = `pap-agent-base-${"2".repeat(64)}`;
const INSTALL =
  "apt-get install -y --no-install-recommends bubblewrap git curl jq python3 ripgrep fd-find ca-certificates e2fsprogs && rm -rf /var/lib/apt/lists/*";

describe("renderDockerfile (R7)", () => {
  it("renders the base layer: packages with e2fsprogs, the fd link, the bundle, the environment, the entrypoint", () => {
    expect(renderDockerfile(base())).toBe(
      [
        `FROM ${DIGEST}`,
        "ENV DEBIAN_FRONTEND=noninteractive",
        `RUN apt-get update && ${INSTALL}`,
        "RUN ln -s /usr/bin/fdfind /usr/local/bin/fd",
        "COPY . /opt/pap/pi-host/",
        "ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 IS_SANDBOX=1 PI_OFFLINE=1 PI_CODING_AGENT_DIR=/agent/.pi/agent GIT_CEILING_DIRECTORIES=/agent",
        'ENTRYPOINT ["/usr/local/bin/node", "/opt/pap/pi-host/dist/guest/main.js"]',
        "LABEL org.pap.layer=base",
        "",
      ].join("\n"),
    );
  });

  it("upgrades the packages only when asked", () => {
    expect(renderDockerfile(base({ upgrade: true }))).toContain(
      `RUN apt-get update && apt-get -y upgrade && ${INSTALL}`,
    );
  });

  it("renders the profile layer on a pap tag", () => {
    expect(
      renderDockerfile(
        base({ layer: "profile", tag: `pap-agent-profile-${"3".repeat(64)}`, from: BASE_TAG }),
      ),
    ).toBe(
      [
        `FROM pap.local/${BASE_TAG}:1`,
        "ENV DEBIAN_FRONTEND=noninteractive",
        "COPY pi-agent/ /opt/pap/pi-agent/",
        "LABEL org.pap.layer=profile",
        "",
      ].join("\n"),
    );
  });

  it("renders the agent layer with its apt packages, or with none", () => {
    const agent = base({ layer: "agent", tag: `pap-agent-agent-${"4".repeat(64)}`, from: BASE_TAG });
    expect(renderDockerfile({ ...agent, aptPackages: ["ffmpeg", "tree"] })).toBe(
      [
        `FROM pap.local/${BASE_TAG}:1`,
        "ENV DEBIAN_FRONTEND=noninteractive",
        "RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tree && rm -rf /var/lib/apt/lists/*",
        "LABEL org.pap.layer=agent",
        "",
      ].join("\n"),
    );
    expect(renderDockerfile(agent)).not.toContain("apt-get");
  });
});
