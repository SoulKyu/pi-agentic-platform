import { imageRef } from "./argv.ts";
import type { ImageBuildRequest } from "./ops.ts";

/**
 * Where the agent bundle lands in the image. The base layer's build context IS the bundle (`BUNDLE_ROOT`: pi-host's `dist`,
 * a flat `node_modules` and `package.json`), so the whole context goes here and the guest starts from `dist/guest/main.js`.
 */
export const BASE_BUNDLE_DIR = "/opt/pap/pi-host";

const NODE_DIGEST = /^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/;

/** R7, RT-14 (e2fsprogs: the guest grows its own disk), RT-06/RT-37 (worker environment). */
const BASE_PACKAGES = [
  "bubblewrap",
  "git",
  "curl",
  "jq",
  "python3",
  "ripgrep",
  "fd-find",
  "ca-certificates",
  "e2fsprogs",
] as const;
const apt = (names: readonly string[], upgrade: boolean): string =>
  `RUN apt-get update && ${upgrade ? "apt-get -y upgrade && " : ""}apt-get install -y --no-install-recommends ${names.join(" ")} && rm -rf /var/lib/apt/lists/*`;

/** Rendered by pap-vmd from a checked `image.build`: the daemon never sends Dockerfile text. `from` is a digest or a pap tag. */
export function renderDockerfile(request: ImageBuildRequest): string {
  const from = NODE_DIGEST.test(request.from) ? request.from : imageRef(request.from);
  const lines = [`FROM ${from}`, "ENV DEBIAN_FRONTEND=noninteractive"];
  if (request.layer === "base") {
    lines.push(apt(BASE_PACKAGES, request.upgrade));
    // Debian names fd `fdfind`; Pi looks for `fd` and, offline, never downloads one.
    lines.push("RUN ln -s /usr/bin/fdfind /usr/local/bin/fd");
    lines.push(`COPY . ${BASE_BUNDLE_DIR}/`);
    // IS_SANDBOX=1: pi-claude-bridge's Claude Code runs as guest root inside the VM, and the VM is the sandbox.
    lines.push(
      "ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 IS_SANDBOX=1 PI_OFFLINE=1 PI_CODING_AGENT_DIR=/agent/.pi/agent GIT_CEILING_DIRECTORIES=/agent",
    );
    lines.push(`ENTRYPOINT ["/usr/local/bin/node", "${BASE_BUNDLE_DIR}/dist/guest/main.js"]`);
  } else if (request.layer === "profile") {
    lines.push("COPY pi-agent/ /opt/pap/pi-agent/");
  } else if (request.aptPackages.length > 0) {
    lines.push(apt(request.aptPackages, false));
  }
  lines.push(`LABEL org.pap.layer=${request.layer}`);
  return `${lines.join("\n")}\n`;
}
