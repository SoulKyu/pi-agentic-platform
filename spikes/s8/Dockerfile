FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap tini \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 pap
COPY --chown=pap:pap probe.sh /home/pap/probe.sh
USER pap
WORKDIR /home/pap
ENTRYPOINT ["/usr/bin/tini", "--", "sh", "/home/pap/probe.sh"]
