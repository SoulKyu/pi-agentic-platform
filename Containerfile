# syntax=docker/dockerfile:1
# Build:  scripts/pap-container.sh build   (pins the base by digest and labels the image)
ARG BASE_IMAGE=docker.io/library/node:24-bookworm-slim

FROM ${BASE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
# Dedicated roots: pap's compiled code must never contain them, so the stage-path guard cannot match it
# (the default HOME /root and a /stage path both appear in compiled imports and comments).
ENV HOME=/pap-image-build
WORKDIR /pap-image-build/src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && node --disable-warning=ExperimentalWarning scripts/stage-app.ts --out /pap-image-build/stage

# Nothing from the build stage is copied except its stage folder: no compiler, no pnpm, no registry credential, no source.
FROM ${BASE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini python3 git openssh-client ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 --shell /bin/bash pap
COPY --from=build --chown=root:root /pap-image-build/stage /opt/pap
COPY --chown=root:root --chmod=0755 scripts/container-entrypoint.sh /opt/pap/entrypoint.sh
USER 10001:10001
ENV HOME=/home/pap PAP_WORKER_SCOPE=off PAP_PORT=7777 NODE_ENV=production
WORKDIR /home/pap
EXPOSE 7777
VOLUME ["/home/pap"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PAP_PORT||7777)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/pap/entrypoint.sh"]
