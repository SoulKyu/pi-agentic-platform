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
  "apt-get install -y --no-install-recommends bubblewrap git curl jq python3 ripgrep fd-find ca-certificates e2fsprogs gh openssh-client util-linux && rm -rf /var/lib/apt/lists/*";

describe("renderDockerfile (R7)", () => {
  it("leaves IS_SANDBOX out of the base environment: pap sets it per agent (ADR 0080)", () => {
    expect(renderDockerfile(base())).not.toContain("IS_SANDBOX");
  });

  it("the base layer builds node-pty in a builder stage and installs gh", () => {
    const text = renderDockerfile(base());
    const [builder, final] = text.split(/^FROM /m).slice(1) as [string, string];
    expect(builder).toContain(`${DIGEST} AS pty-builder`);
    expect(builder).toContain("build-essential python3 make g++");
    expect(builder).toContain("npm install --no-audit --no-fund node-pty@1.1.0");
    expect(final).not.toContain("build-essential");
    expect(final).toContain(" e2fsprogs gh openssh-client util-linux ");
    expect(text).toContain(
      "COPY --from=pty-builder /build/node_modules/node-pty /opt/pap/pi-host/node_modules/node-pty",
    );
    expect(text.indexOf("COPY . /opt/pap/pi-host/")).toBeLessThan(text.indexOf("COPY --from=pty-builder"));
    expect(renderDockerfile(base())).toBe(text);
  });

  it("renders the base layer: packages with e2fsprogs and gh, the fd link, the bundle, the pty, the environment, the entrypoint", () => {
    expect(renderDockerfile(base())).toBe(
      [
        `FROM ${DIGEST} AS pty-builder`,
        "ENV DEBIAN_FRONTEND=noninteractive",
        "RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 make g++ && rm -rf /var/lib/apt/lists/*",
        "RUN mkdir /build && cd /build && npm install --no-audit --no-fund node-pty@1.1.0",
        `FROM ${DIGEST}`,
        "ENV DEBIAN_FRONTEND=noninteractive",
        `RUN apt-get update && ${INSTALL}`,
        "RUN ln -s /usr/bin/fdfind /usr/local/bin/fd",
        "COPY . /opt/pap/pi-host/",
        "COPY --from=pty-builder /build/node_modules/node-pty /opt/pap/pi-host/node_modules/node-pty",
        "RUN chmod 0755 /opt/pap/pi-host/bin/* && ln -s /opt/pap/pi-host/bin/gh /usr/local/bin/gh && ln -s /opt/pap/pi-host/bin/pap-ssh-sign /usr/local/bin/pap-ssh-sign && ln -s /opt/pap/pi-host/bin/pap-connect /usr/local/bin/pap-connect",
        "RUN printf 'Host *\\n  ProxyCommand /usr/local/bin/pap-connect %%h %%p\\n  ServerAliveInterval 60\\n' > /etc/ssh/ssh_config.d/pap-proxy.conf",
        "ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 PI_OFFLINE=1 PI_CODING_AGENT_DIR=/agent/.pi/agent GIT_CEILING_DIRECTORIES=/agent",
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
