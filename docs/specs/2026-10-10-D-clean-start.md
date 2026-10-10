# Spec D: clean start (no migration)

Status: draft for review · Date: 2026-10-10 · Decision 24 (supersedes the import part of decision 6) · Illustrated version: [migration/01-clean-start.html](../migration/01-clean-start.html).

## 1. Rules

1. **pap imports nothing from pi-web.** `~/.pap` starts empty. Agents, triggers, lanes and settings are recreated in pap.
2. **Pi stays shared.** `~/.pi/agent` keeps provider auth, `models.json`, `settings.json`, extensions, skills, subagents, mem0 and `mcp.json`. Nobody logs in again and nothing is reinstalled.
3. **Sessions are indexed from the pap install date.** The install timestamp is the scanner cutoff. Pi sessions created after it, from pap or from the `pi` CLI, appear in pap. Older sessions stay reachable in Pi and pi-web only.
4. **pi-web files are ignored.** pap never reads `pi-web-session-*.json`, `agent-ops/`, `agent-spaces/`, `agents-home/` or `agents-secrets/`.
5. **pi-web is never modified.** Rollback means reopening pi-web.

## 2. Cutover

| Step | What happens |
|---|---|
| 0. Freeze | pi-web finishes lanes Lot B, then gets bugfixes only (decision 9). |
| 1. Install | pap is installed alongside on `127.0.0.1:7777` and becomes the tool for **new** sessions. pi-web stays open for history and existing agents. |
| 2. Recreate | The user recreates the agents and triggers worth keeping, using the forms and dry-run. Each webhook sender (Alertmanager, Grafana) gets the new URL and secret. Each trigger recreated in pap is disabled in pi-web the same day. |
| 3. Stop pi-web | Once nothing runs in pi-web, its service is stopped and pap takes its host and port (or the reverse proxy is switched). pi-web stays installed for 30 days, then the repository is archived. |
| 4. Clean up | A documented, manual list of pi-web-only files in `~/.pi/agent`. That includes the long-term agent `.md` profiles in `~/.pi/agent/agents/`, which Pi otherwise shows as subagents. |

## 3. Risks

- **The same session open in both apps.** pi-web also sees pap's new sessions, because the Pi files are shared and have no lock.
  - Mitigation: a usage rule during coexistence: never resume a pap session in pi-web.
  - pap also warns when a session file changes without its worker having written to it.
- **A trigger firing twice.** Avoided by disabling the pi-web trigger when it is recreated in pap (step 2).

## 4. What this removes from the other specs

- No `pap import pi-web` command, import report or pi-web format fixtures.
- No alias route for the old webhook path.
- The first session scan is small, which lowers the scanner risk noted in spec C §3.
