# Boxes, lot B2: the terminal and GitHub in a box

Date 2026-10-24. Status: lot design. Programme: `docs/specs/2026-10-23-boxes-design.md` (decision 124); lot B1: `docs/specs/2026-10-23-boxes-b1-design.md` (merged 84bcea21, decision 125); B0 results: `docs/research/boxes-b0-spike.md` (§1 terminal, §4 GitHub App). ADR to write with this lot: 0084, "GitHub through a pap GitHub App" (supersedes 0036 for box projects; host projects keep `gh` until B4). Calls the controller made without the owner are marked *(controller's call)*.

## 1. Scope

The owner asked for the whole GitHub integration in this lot (2026-10-24: « Tout », after the roadmap's M14 list). In B2:

- the terminal of a box project runs in its box;
- a pap GitHub App: created from pap, installed on the owner's account, authorized by the owner;
- a project from GitHub: clone or fork, picked from the owner's repositories or typed as `owner/name`;
- per box launch, a one-hour token limited to the project's repository, renewed by the host;
- per project, an SSH signing key made in the box and added to the owner's account, so commits show "Verified";
- push and pull requests from the box (terminal, sessions, and buttons on the project page);
- GitHub hosts on the project's list;
- on the project page: pull requests with their checks and the log of a failed check, issues, releases; a failed check's log or an issue can be handed to a session.

Later:

- review comments of a pull request inside the lane review (with lanes, B3);
- several pap users with their own GitHub accounts, and projects scoped to users (M14);
- the host clean-up (B4: host projects keep `gh` and the host terminal until then);
- creating a GitHub repository from pap *(controller's call: an empty project links an existing repository; creating one stays on GitHub)*.

Facts from the code recon that the plan must handle:
- the gateway carries request/response guest ops only; nothing streams, and the terminal module is built on a host `PtyProcess` (pid, `/proc`, kill ladder);
- the session cookie is `SameSite=Strict` and the CSP has `form-action 'self'`: a redirect back from github.com arrives without the cookie, and the SPA cannot POST a form to github.com;
- pap holds no forge credential today (ADR 0036); the guest's spawn environment is a closed allowlist; pap-vmd takes no environment from the daemon;
- the vault has an unused per-user scope (`{kind: "user"}`) meant for a per-user forge token;
- a project box starts with an empty host list; the proxy already reads the owner's list plus the project's per connection.

## 2. The terminal in the box

- **Where it runs.** A terminal whose cwd is at or under a box project's root runs in that box, as the guest's root user, without bwrap (it is the owner, programme §4), with `HOME = home/`, cwd the folder asked, the proxy environment, and the project's git identity and GitHub credentials (§5). Host projects keep the host terminal until B4.
- **node-pty in the image.** The base image gains node-pty built in a multi-stage step from the same base (B0 §1); the guest loads it from the bundle's path *(controller's call)*.
- **Transport.** Each terminal is its own gateway connection, like a worker: the guest opens a pty when the daemon asks, and the pty connects back with a hello of role `terminal` and the slot it was given. Frames: daemon to guest `pty_input {data}`, `pty_resize {cols, rows}`, `pty_ack {bytes}`, `pty_signal {signal}`; guest to daemon `pty_output {data}`, `pty_exit {code, signal}`. Data is base64 in the existing length-prefixed JSON frames. The guest stops reading the pty while more than 1 MiB is unacknowledged *(controller's call: the host terminal's own window)*.
- **The daemon keeps its terminal module.** A remote pty implements the interface the module already uses (write, resize, data, exit, kill), so the ring buffer, scrollback, multi-client attach, `PAP_MAX_TERMINALS`, the binary frames to the browser and the kill ladder stay as they are; the kill ladder sends `pty_signal` (SIGHUP, then SIGKILL) instead of signalling a host pid.
- **Lifecycle.** Opening a terminal starts the box if it is stopped (it is an explicit action, like Start). A terminal counts as a worker for the idle stop while a browser is attached to it or it printed something in the last `PAP_WORKER_IDLE_MINUTES`; a detached, silent terminal stops counting, so a shell left open in a closed tab does not keep a 2 GiB box running *(controller's call, FinOps)*. Stopping or restarting the box, a daemon restart or a lost gateway link ends its terminals (`exited`), as a host terminal ends with the daemon. The terminal list shows which project a terminal belongs to.
- **Refusals.** A box that cannot start answers the start codes (`capacity`, `vm_bundle_stale`, `agent_paused`, `sandbox_unavailable`); a cwd outside every root stays `not_found`.

## 3. The GitHub App

- **Creation.** Settings › GitHub › "Create the GitHub App" opens a page the daemon serves on its own route, outside the SPA, with its own CSP that allows `form-action https://github.com`; it posts the manifest to `https://github.com/settings/apps/new` with a single-use `state` *(controller's call: the SPA's CSP stays as it is)*. The manifest: name `pap-<host label>-<4 hex>`, `public: false`, webhooks off, `redirect_url` and `callback_urls` on pap's own address, `request_oauth_on_install: true`, repository permissions `contents: write`, `pull_requests: write`, `issues: read`, `checks: read`, `actions: read`, `metadata: read`, and `administration: write` (GitHub's fork endpoint asks for it; only the host's user token ever carries it, box tokens are minted without it) *(controller's call)*.
- **Callback address.** `redirect_url` and `callback_urls` use the origin the owner's browser used to start the creation (B0: a plain `http://` LAN address works). pap records it; when the owner later reaches pap from another origin, Settings › GitHub says the App's callback no longer matches and gives the exact URL to paste in the App's GitHub settings (GitHub has no API for it) *(controller's call)*.
- **Account permissions.** A manifest refuses them (B0 §4). After the creation, the page tells the owner to set "SSH signing keys: Read and write" on GitHub's settings page for the App, with a direct link, then to install it. If the owner installed first, GitHub asks them to accept the new permission on the installation: pap detects the missing permission at the first key upload (GitHub's 403) and Settings › GitHub shows "accept the new permission on GitHub, then Reconnect", with both links *(controller's call)*.
- **Callbacks without the cookie.** The creation redirect and the install/authorization callback are matched by their `state` (random, single use, ten minutes, bound to the user who started the flow), not by the session cookie (SameSite=Strict drops it on a cross-site redirect). The callback does its server-side exchange, then answers a small pap page that navigates back into the app (a same-site navigation, so the cookie applies again).
- **What pap stores.** The App's id, slug, client id, client secret and private key in `$PAP_HOME/secrets/github-app.json` (0600, read without following links, at most 16 KiB); the owner's user token and refresh token in the vault's user scope. A backup of the whole `$PAP_HOME` holds them, like the vault key (AGENTS.md). Values never reach a log, an audit row or a response; the redactor learns them.
- **Tokens.** The user token lasts 8 hours; the host refreshes it with the refresh token before use, one refresh at a time (single flight), writing the new pair to the vault before using it (GitHub rotates the refresh token at each use). A refresh that fails, or a refresh token past its 6 months, puts Settings › GitHub in "Reconnect needed" with a Reconnect button (the authorization flow again); fork, link and key upload answer `github_unavailable` meanwhile *(controller's call)*. Installation tokens are minted by the host with the App's key (a JWT valid at most 10 minutes), limited to one repository and to the permissions the use needs: `contents` + `pull_requests` write for a box, read-only scopes for the project page's lists.
- **Installation.** On all repositories by default, picked repositories work too; a clone or fork the App cannot reach stops with a message naming the GitHub step that adds the repository (programme §9). Every installation of the App the owner can access counts, organisations included: the picker lists the repositories of each installation, and the host finds a repository's installation with GitHub's per-repository lookup *(controller's call)*.
- **Removal.** Settings › GitHub › "Disconnect" forgets the user token; "Delete the App" shows the GitHub settings link to delete it there and forgets every App secret here. Projects keep their files; GitHub actions answer `github_unavailable` until the App is set up again.

## 4. A project from GitHub

- **Create.** The New project dialog gains a source: Empty (B1) or GitHub. GitHub offers the owner's repositories (through the user token) or a typed `owner/name`, then **Clone** or **Fork** (the owner picks). The project's name defaults to the repository's name.
- **Clone.** The project row records `github: {repository, fork: false}`; at the box's first start the guest clones over HTTPS with the box's token into `project/`.
- **Fork.** The host forks into the owner's account with the user token (`POST /repos/{owner}/{repo}/forks`), waits until the fork answers (bounded wait, then a clear failure), records `github: {repository: <fork>, upstream: <original>, fork: true}`, and the guest clones the fork with `upstream` set to the original.
- **Link.** An Empty project can link an existing repository from its settings (`origin` is added in the box, nothing is pushed by pap). Unlinking removes `origin` and the signing key.
- **Host list.** A GitHub project's host list gets `github.com`, `api.github.com`, `codeload.github.com` and `objects.githubusercontent.com` at creation or link, visible and removable like any entry *(controller's call: the exact list B0 needed for clone, push, `gh` and release assets)*.
- **Failures.** A clone or fork that fails leaves the project with an empty `project/` and a project-page notice saying what failed and that the clone can be retried (`projects.cloneAgain`); nothing is deleted.

## 5. Identity, tokens and the box

- **Token delivery.** At each box start, and every 45 minutes while it runs, the host mints a token for the project's repository and sends it to the guest with a guest op `github.token {token, expiresAt}`; the guest writes it to a file on its tmpfs (`/run`, 0600) that a git credential helper and a `gh` wrapper read *(controller's call: the guest's spawn environment stays a closed allowlist and pap-vmd takes no environment)*. A box with no GitHub link gets none.
- **What can read it.** Every process of the box can read the token, the model included; its reach is one repository for one hour, and the proxy keeps the box to the project's hosts (programme §12). The docs say so.
- **Signing key.** At the first start of a GitHub project the guest creates an ed25519 key in `home/.ssh/` (the private key never leaves the box) and reports the public key with a guest op; the host adds it to the owner's account as an SSH signing key named `pap <project name> <project id first 8>` and keeps its GitHub id. The guest sets `user.name` (the GitHub login), `user.email` (the noreply address `<id>+<login>@users.noreply.github.com`), `gpg.format ssh`, `user.signingkey` and `commit.gpgsign true` in the project's repository config. Deleting or unlinking the project removes the key from GitHub; a failed removal is retried at the next daily sweep and shown in Settings › GitHub.
- **Who commits.** Commits are the owner's, signed by the project's key. An agent working in the box commits as the owner too *(controller's call: one identity per project in B2; per-user identities are M14)*.

## 6. Push and pull requests

- **From the box.** `git push` and `gh pr create` work in the terminal and in sessions (the shell's network goes through the proxy; the hosts are on the list).
- **From the project page.** A "Changes" panel action **Commit and push** (message field, the current branch) and **Open a pull request** (title, body, base branch defaulting to the repository's default) run in the box through guest ops (`git.commit`, `git.push`, `gh.prCreate`) *(controller's call: thin buttons over the same commands; lanes keep their own flow until B3)*.
- **A fork's pull request to its upstream.** The box's token reaches the fork only, and the App is not installed on someone else's upstream, so pap cannot open that pull request through the API. For a fork project, **Open a pull request** opens GitHub's compare page (`https://github.com/<upstream>/compare/<base>...<login>:<branch>`) in the owner's browser after the push; pull requests inside the fork itself work like any project. The GitHub tab of a fork lists the fork's own pull requests, issues and releases *(controller's call)*.
- **Under taint.** The page's buttons are the owner's own action on their repository, after they see the diff in Changes: they do not ask under taint *(controller's call: the programme left "the card" to B2; GitHub traffic goes through the proxy like any host, so the first clone would taint every launch and a confirmation would fire on every push)*. Inside the box nothing changes (the box is the boundary, the token reaches one repository).

## 7. Pull requests, checks, issues, releases

- **Where.** A "GitHub" tab on the project page of a GitHub project, with three sections: Pull requests (open, with their checks), Issues (open), Releases (latest 20). Lists are read by the host with a read-only installation token for the repository, cached 60 s, at most 50 items each, refreshed on demand *(controller's call)*.
- **Checks.** A pull request shows each check's state (DESIGN.md chip tones: `ok`, `run`, `err`, `mut`). A failed check opens its log: the last 64 KiB of the failed job's log, fenced as external content (`UNTRUSTED · github actions`).
- **To a session.** "Send to a session" on a failed check's log or on an issue starts or continues a session of the project with the text fenced as external content (`UNTRUSTED · github issue` / `github actions`); the session is tainted, as any external read is.
- **Releases** are read-only in B2: tag, name, date, notes (fenced), assets as links.
- **Text from GitHub is never trusted:** titles, bodies, logs and notes are shown as text only (no HTML, no markdown links that execute), fenced in the UI per DESIGN.md §2.

## 8. Permissions and RPCs

- Settings › GitHub (App creation, authorization, disconnect): `settings:admin` with the password step-up for creation and deletion; browser only (tokens never).
- Project GitHub actions (create from GitHub, link, clone again, commit and push, PR create): `sessions:operate`, browser only; the lists and logs: `sessions:read`, a token may read them *(controller's call)*. A token cannot call the push or PR methods; a session it drives can still push from inside the box, as a host session can push with the host's credentials today (a documented limit).
- New RPC names are the plan's within `projects.*` and a new `github.*` group; every method declares its permission and errors (`github_unavailable` when the App is not set up, `not_found`, `conflict`, `capacity`, `box_stopped`, `bad_request`).

## 9. UI

DESIGN.md applies (tokens, primitives by variant, colour = role, EN and FR, the three-part errors, the fence for external content, feedback timing, 44 px targets, polite live regions).

- Settings › GitHub: state (not set up / App created, permission missing / connected as `<login>`), the steps in order, Disconnect, Delete.
- New project: the source choice; the GitHub picker (search, Clone / Fork).
- Project page: the GitHub tab (§7); the Changes panel's Commit and push / Open a pull request; the terminal button enabled for box projects; settings: Link / Unlink a repository, the signing key's state.
- Terminal: a box terminal looks like a host one; its tab names the project.

## 10. Tests

- Process backend for the box side (the real guest, a pty in the guest process, frames over the real gateway); a fake GitHub on loopback for every GitHub call (tests never contact a public host); the existing network guard stays on.
- Journeys: open a terminal in a box, type, resize, reattach after a browser reconnect, the box idles out only after the terminal closes; create the App against the fake GitHub (manifest, callback with state, permissions check), authorize, create a project by clone and by fork, the token reaches the guest and is renewed, a signing key is added and removed with the project, commit and push and open a PR through the buttons, the lists and a failed check's log, "Send to a session" taints the session; a callback with a reused or foreign `state` is refused.
- Kata (local, root window): a real terminal in a real box; clone and push against the fake GitHub is enough there *(controller's call: no test touches github.com)*. The owner checks the real flow on `SoulKyu/cpg` after the merge.

## 11. Docs

ADR 0084; the boxes section of `agents-vm.md` (terminal, GitHub); `terminal.md`, `lanes.md` (host `gh` until B4), `web.md`, `auth.md` (callbacks, state), `install.md` (Settings › GitHub); the decisions log; the roadmap (B2; M14 keeps multi-user and the lane review comments move to B3).

## 12. Left to the plan

Frame names and limits beyond those above, the remote pty adapter's shape, the base image change, the fake GitHub's shape, RPC names, where the GitHub module lives in the daemon, the settings page layout, and how the work splits into lanes.
