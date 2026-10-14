# ADR 0027: project trust from pap

Status: accepted (M7, Task 22)

## Context

Pi gates a project's own files (`.pi/mcp.json`, `.pi/extensions`, `.pi/skills`, `.agents/skills`, prompt templates, `.pi/settings.json`, `SYSTEM.md`) behind a trust decision kept in `trust.json` of its agent directory. A project can therefore run code on the owner's machine once it is trusted, and a decision on a folder is inherited by every folder under it. Pi's own CLI asks the question in a dialog. pap's workers open every project untrusted, so without a way to decide, a project's MCP servers, extensions and skills never load from pap.

## Decision

- The decision is Pi's `trust.json`, read and written only through Pi's `ProjectTrustStore`, and only in a helper (ADR 0023). The store can busy-wait on its lock and needs a writable agent directory, so it never runs on the daemon's request path. The key is the session folder's real path; a symlinked spelling is judged by where it leads. Pi writes the file with sorted keys; clearing a decision removes the key.
- Two methods, both `pi:admin` (browser sessions only, never a token): `trust.status { cwd }` and `trust.set { cwd, decision: true | false | null }`. `trust.status` is not `pi:read` because it lists the project's MCP servers, and those views are masked heuristically (MC38). The `cwd` must be a folder the caller has a session or a project in (`invalid_cwd` otherwise), as for the MCP views (M7R50).
- Trusting (`true`) takes the password step-up (M7R133), and so does clearing (MC47): removing an explicit `false` under a trusted parent widens trust. Only `false` asks for nothing, because it only narrows. Clearing also has no breadth rule.
- Home: the helper uses `$HOME`, else the account's own home folder (`os.userInfo().homedir`), never `/`.
- Breadth rule (M7R104, the same rule as pi-web's): trusting is refused for `/`, the home folder or any ancestor of it, a folder holding Pi's agent directory or pap's home, and a folder that strictly holds another known project (the projects module's roots). Every path is compared as a real path. The helper decides, from its own facts and the roots the daemon hands it. A refusal is an answer, not an error: `trust.set` returns `{ ok: false, refusal }` with one of four fixed rule names, and the web client shows the copy for each (`trust.refusal.*` in `apps/web/src/i18n/catalog/trust.ts`; `send-decision.ts` reads `result.ok === false`, never an `error`). This is a deviation from the plan's "`forbidden` with a typed reason": the wire error carries only a code from a closed list, and a refusal that names its rule needs more than that.
- `trust.status` lists what trusting turns on, from files only and never a value (M7R107): the project's MCP servers masked by the overview's reader (HTTP servers name the variables they send), extension file names, skill names, the number of prompt templates, the top-level keys of `.pi/settings.json`, and whether `SYSTEM.md` or `APPEND_SYSTEM.md` exist. Each list is bounded (200, 100, 100, 50) and a `truncated` flag says when one was cut. `unlisted` names, as fixed strings (a project-relative path and a reason, never file content), what pap did not list although Pi may load it once trusted: a resource folder that is a link out of the session folder (not followed, M7R84) or cannot be read, a settings file that cannot be read, an MCP file the overview's reader refuses (too many servers, too large, a link out), a folder with more entries than the scan reads. The dialog shows "pap could not list everything" when it is not empty, so it never looks complete when it is not. Names are untrusted file names: control, bidi and zero-width characters are removed and each is clipped to 128 characters. A directory that is a link leading out of the project lists nothing.
- A store that cannot be read (corrupt file, wrong shape, a held lock) makes the decision `null` in `trust.status`, with the store's own message logged once in the helper, and makes `trust.set` fail with `helper_failed`. Nothing is ever decided on a guess (fail closed, like the worker's resolver).
- Decisions are written one at a time by the trust service (its own queue: `trust.json` is not `settings.json`, so the shared Pi write queue does not apply), on top of the store's own file lock.
- Audit rows `project_trusted`, `project_untrusted`, `project_trust_cleared` carry the folder and nothing else (M7R106).
- A decision applies at the next open of a worker (M7R105). After a decision the sessions module releases the owner's workers in that folder or below (`restartFolder`): idle ones at once, working or starting ones when their run is over. The session stays and goes cold; its next prompt starts a worker that reads the new decision. The loadout of that worker says `projectTrust: { required, trusted }`, filled from the resolver's answer at open, so the interface can show which state a running session has. The field is optional in the contract: a worker older than this change does not send it.

### Web: lint exception and step-up context (Task 23, MC49)

- Deviation from the web layering rule that a feature imports only its own domain: `eslint.config.js` (`boundaries/element-types`, the rule after the generic `web-feature` one) lets the `sessions`, `mcp` and `skills` domains import the `trust` domain, and no other. `sessions` mounts the banner (one line), `mcp` opens the dialog from `McpSection`, `skills` opens it from the untrusted-project "Review" button. The first version of the exception named `sessions` and `mcp`; Task 26 added `skills`.
- The dialog asks for the password through `useStepUpRunner` (`apps/web/src/lib/step-up-context.tsx`), provided by `routes/shell/StepUpHost.tsx`, so no feature imports `routes/` or `features/auth`. Detail: `docs/agents/web.md`.

## Consequences

- The breadth rule compares with at most 2000 known projects. Past that, trusting fails closed with `capacity` (logged); `false` and clearing do not use the list.
- Accepted residuals:
  - The window between the helper's check and Pi's own write inside `ProjectTrustStore.set` (Pi realpaths the folder again). A same-user process can write `trust.json` directly anyway; it matters once the M11 sandbox exists.
  - The decision is not bound to what the dialog listed: `trust.status` is read when the dialog opens and `trust.set` lands after the step-up, possibly minutes later. Anything added to `.pi/` in between (a `git pull`, the `pi` CLI) is trusted without having been shown. Agent writes to `.pi/` are protected and ask, which narrows the window. A digest of the listed resources, recomputed in the helper with `conflict` on a mismatch, is an owner option.
  - A bind mount of the home folder is not seen by `realpath`, so the breadth rule does not recognise it.
  - A decision stops workers that hold background processes or open dialogs, after their run (M7R105). The dialog's restart copy says so.
  - `compose-pi.ts` edits two existing lines (the `rpc` type and the spread), as its own pattern requires. Lane A's Task 24 edits the same two: the rebase keeps both sides.

- pap still does not read `defaultProjectTrust` from Pi's settings, nor does it handle the `project_trust` extension event (ADR 0001 stands). Pi's CLI may therefore trust a folder that pap shows as undecided. pap shows the store's decision for the folder, or the nearest folder above it (`inherited`), and nothing else.
- A decision made by the CLI while a worker runs is not seen by that worker until it is reopened; the status call reads the file each time.
- An owner who wants to trust a whole workspace folder trusts each project: the breadth rule refuses the parent while it holds other known projects.
- A session being created at the moment of a decision, before it is recorded, is not restarted; it opens with whatever the store held when it read it.
