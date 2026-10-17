# ADR 0065: the OCI image

Status: accepted (M6b, task 12, 16)
Date: 2026-10-17
Spec: R52b, spike S8. Rulings: M6bR29 to M6bR32, owner b7, M6b-RT-07, RT-26, M6b-C5, C6. Guide: `docs/agents/install.md` (Container).

## Decision: the option set

The image runs under rootless podman only, with exactly the measured set: `--user 10001:10001 --userns=keep-id:uid=10001,gid=10001 --cap-drop ALL --security-opt no-new-privileges --security-opt systempaths=unconfined`, published on `127.0.0.1:<port>` only (ADR 0004's loopback cookie rule). The wrapper has no `--privileged` and no `--cap-add`, and refuses root, a podman that is not rootless and any runtime but podman.

- `keep-id` maps the host uid onto 10001, so a `--project DIR` mounted at `/work/<name>` is writable by the container user. Without it the folder shows as `root:root 755` (M6b-RT-07). The wrapper refuses `/`, the home folder and its parents (under keep-id they would make the whole home writable as the user) and, since the join, also an unset `HOME`.
- `systempaths=unconfined` unmasks `/proc` and `/sys` paths for the whole container. S8 measured, for a non-root user with no capabilities, read access to `/proc/interrupts`, `/proc/keys`, `/proc/latency_stats` and listings of `/proc/acpi`, `/proc/scsi`, `/sys/firmware`, and no write access. As container root `/sys/fs/cgroup` becomes writable, which is why the image runs as a non-root user with every capability dropped. Cost if wrong: a container escape starts with more host information than the default masks give. Owner b7 accepted this for the sandbox, which cannot run without it.
- Rootless only: rootful Docker was not measured and is not supported.

## Decision: fail closed in three places (M6bR30)

1. The M11 launch probe makes agents that require the sandbox refuse with `sandbox_unavailable` when bubblewrap cannot run.
2. The entrypoint runs `pap doctor --only bwrap` and logs one `container_sandbox_unavailable` warning; the daemon still serves.
3. `pap doctor` has the real `bwrap` check (the sandbox probe, never a PATH scan), whose hint names `--security-opt systempaths=unconfined` first inside a container.

## Decision: content and build

The staged production tree is the archive's (`stageTree`), built in a first stage that never reaches the final image: no compiler, no pnpm, no registry credential, no source. Build and archive recipes use unique-by-construction roots (`/pap-image-build`, `/pap-archive-build`) with a regression test that no pap source contains them (M6b-C5), so the stage-path guard cannot match pap's own compiled code. `build` pins `node:24-bookworm-slim` by digest read after a pull and passes `--format docker` to keep the HEALTHCHECK. apt packages float: the image is not byte-reproducible. The archive-in-container recipe mounts the checkout read-only and copies it inside, needs a normal clone and a `--node-tarball` (M6b-C6).

## Not covered

SELinux hosts (no `:z` on mounts), rootful Docker, a registry push, the image build itself (built by hand, Appendix A step 9: the plan session had no network).
