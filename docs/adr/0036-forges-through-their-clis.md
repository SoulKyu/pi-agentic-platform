# ADR 0036 — Forges are reached through their own CLIs, GitHub only in M9

Status: accepted · Date: 2026-10-14 · Spec: C §1.1 (child processes), C §6 · Rulings: M9R46-M9R50, M9R82, M9R103, M9R107, M9-RT-04, M9-RT-21

## Context

A lane ends in a pull request, and may start from an issue. The forge's API needs a token, and pap would have to hold it. The owner already has a forge CLI signed in. Spec C §1.1 allows a CLI child.

## Decision

- pap runs `gh` (GitHub's CLI) as a child. It never holds a forge token. `gh` answers from its own login (`gh auth login`); `GH_TOKEN` and any token variable are not passed.
- **From an empty folder.** The child's cwd is `$PAP_HOME/tmp/forge` (0700), never a repository, with `GIT_CEILING_DIRECTORIES` set to its parent, so `gh` and the git it starts cannot pick up a lane's config.
- **The environment** is `forgeEnv`: the unattended allowlist, the proxy and CA variables, `TMPDIR`, `XDG_*`, `GH_CONFIG_DIR`, and fixed quiet flags (`GH_PROMPT_DISABLED`, `NO_COLOR`, no update notifier).
- **Explicit repository.** Every call has `--repo=<host/owner/repo>` built from a parsed remote, every value is joined to its flag with `=`, and the PR body goes on stdin. Output is parsed with a strict schema; text from the forge is clipped and stripped of control and invisible characters.
- **Host binding.** An issue link is accepted only on github.com (any repository) or on the project's own forge host, taken from `remote.origin.url` as configured. A pasted link to another host is refused before a CLI starts. A pull-request search ignores forks.
- **GitHub only** (owner m9q5). `forgeFor` returns an adapter for `github` alone. GitLab and Gitea issue URLs answer `unsupported_url` ("not supported yet"), and `glab` is never spawned. Gitea / Forgejo and Linear need a token pap would hold, so they wait for M11's vault; GitLab is deferred for scope.
- Permissions: `lanes.issue`, `lanes.prCreate` and `lanes.prRefresh` are `lanes:admin`; a token never reaches a forge.

## Consequences

- If `gh` is missing, signed out or slow, the typed outcomes are `forge_missing`, `not_signed_in`, `not_found` or `timeout`. Fix with `gh auth login` as the daemon's user.
- Adding GitLab later is one adapter behind `forgeFor` plus its argument builder; the host binding and the environment already apply.
- `gh` runs with the daemon's network; it cannot use an SSH agent or a token from the environment.
