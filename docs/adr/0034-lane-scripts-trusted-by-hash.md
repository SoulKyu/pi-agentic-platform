# ADR 0034 — Lane scripts are trusted by the hash of their text, in pap's own table, and run from the browser only

Status: accepted · Date: 2026-10-14 · Spec: C §6 (lanes), A (D03, D22) · Rulings: M9R21-M9R30, M9R103, M9R108, M9R110, M9R119, M9-RT-01

## Context

`.pi/project.yaml` can carry `setup`, `archive` and `test` scripts. They are shell text from a repository, run as the owner. Three questions: who approves them, who may start them, and what environment they see.

Pi has a project trust store (`trust.json`, ADR 0027). It answers "may this project load extensions and skills". It is about a folder, not about a piece of shell text, and it does not notice an edit to a script.

## Decision

- **pap's table.** `lane_script_approvals` holds one row per owner, project and kind: the sha256, the approved text and the time. The runner runs the text only when the script now in the main checkout's `.pi/project.yaml` hashes to the stored value. An edit un-approves the script. The UI shows "changed since you approved it" with the previous text (decision 30).
- **Bound to what was shown.** `lanes.approveScripts` takes the hashes the owner saw. The service re-reads the file and answers `changed` if a hash is not current, so the owner never approves text that differs from what was displayed.
- **Step-up and browser only.** Approval needs the password step-up and a browser session. A token is `forbidden`; `lanes:admin` is never a token permission. **Running** is browser only too: `lanes.runScript` is `lanes:admin`. A lane created by a token keeps its setup `pending` ("Run setup" in the browser) whatever was approved. An API client cannot run lane tests or setups; that friction is accepted.
- **Tainted lanes.** If a session of the lane (archived ones included) has read external content, a run or an archive with an archive script answers `tainted` until the owner confirms inline. The one script that starts without a click, a fan-out lane's test run after the first run, also requires a browser-created lane, a non-issue source and no tainted session, checked again right before the spawn.
- **The text the owner's checkout holds decides.** A lane based on someone else's branch still runs the owner's approved scripts. What those scripts install (a branch's package scripts) is not covered; the approval box says so.
- **The unattended environment.** A script gets `unattendedEnv`, an allowlist: `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TZ`, absolute `PATH` entries, `TERM=dumb`, the proxy and CA variables, `TMPDIR`, `XDG_*`, plus `PAP_LANE_*`. Never passed, even when named: the SSH agent, `GIT_*`, `LD_*`, provider families, anything credential-shaped. The same helper serves `gh`, M7's install children and M10's precheck (`packages/contracts/src/child-env.ts`; the daemon re-exports it from `kernel/child-env.ts`).
- Spawn: `bash -e -c <text>` under the daemon's starting umask, stdin closed, own process group, in a systemd scope when available, 5 MiB log, deadlines 30 / 15 / 5 minutes.

## Consequences

- A registry token only in `NPM_TOKEN` is not seen: put it in `~/.npmrc`. Tool variables (`JAVA_HOME`, `GOPATH`, `NVM_DIR`) must be exported in the script. A private source over ssh needs the terminal. `gh` answers from `gh auth login`.
- Until M11's sandbox a script is unsandboxed: it can do what the owner can do. The controls above decide who may start it, not what it does.
- M7's `npx`, `npm` and `git` install children moved to the same environment; decision 79's environment option is closed.
