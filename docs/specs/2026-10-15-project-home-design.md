# Project home: every action without a shortcut

Status: design approved by the owner on 2026-10-15 (decision 85). Question page: `docs/design/questions/2026-10-15-project-home.html`; answers in `…-answers.json`.

## 1. Problem

The home screen (`apps/web/src/features/sessions/SessionListScreen.tsx`) offers only:
- a folder field and a tool preset;
- "New session";
- ten recent sessions.

The project chip only filters. A code inventory of 86 actions found these gaps:
- **New lane** (with an issue, or a fan-out) is reachable only by ⌘⇧L, ⌘K, or a "…" menu hidden in the ⌘B tree.
- **The tasks board, the triggers and "New trigger"** are reachable only by ⌘K.
- **A closed compare tab** reopens only by URL.
- **The shortcuts help and transcript search** are reachable only by a key or the palette.
- **"Add project"** has no UI at all: a project only appears when a session opens in a folder.
- **On the phone**, Settings, the account, tasks, files and the home itself need the palette.

The owner's rule: everything pap can do on a project is visible and clickable from the home. Shortcuts and ⌘K stay, as accelerators.

## 2. Goals and non-goals

**Goals**
- One project home that starts any piece of work and reaches every project-level view.
- Every action that is palette-only or shortcut-only today gets a visible entry.
- "Add project" exists.
- The owner can hide the parts of the home they do not use (Settings).

**Non-goals**
- The full mobile redesign (M12). This work only gives the phone its minimum entries.
- GitHub clone, fork and per-user tokens (decision 84).
- Per-project spend. `usage.summary` is owner-wide; a project filter is a separate change.
- Changing the New lane dialog or the trigger editor. They are reused as they are.

## 3. The screen

Route: the current home route. `ProjectHome` replaces `SessionListScreen` as the home. The project is the one chosen in the top-bar project chip, or "All projects".

### 3.1 Composer (first, focused on load)

- A mode choice as a radio group of chips: **Session · Lane · Fan-out · Trigger**. The default is Session. The last mode used is remembered per device.
- One multi-line field. Placeholder: "What do you want to do in <project>?" (EN/FR).
- **Launch** button. Enter launches and Shift+Enter adds a new line, the same as the session composer.
- "Options" disclosure, Session mode only: the tool preset picker that the current home has.

What each mode does on Launch:

| Mode | Action |
|---|---|
| Session | Today's behaviour: `sessions.create` in the project root with the text as the first message, then opens the session. |
| Lane | Opens the existing New lane dialog with the project set. The title is the first line, clipped to the title limit; the description is the remaining lines. |
| Fan-out | The same dialog, with two model slots preset (the owner can change to 1–4). |
| Trigger | Opens the existing trigger editor for this project. The trigger name is the first line, clipped; the prompt is the text. |

When the text is empty:
- Session opens an empty session, as today.
- The other modes open their dialog empty.

### 3.2 Action row (visible buttons under the composer)

The buttons are in groups. Each group can be hidden from Settings (§6).

| Group | Buttons |
|---|---|
| Explore | Files · Terminal · Search |
| Automate | Tasks · Inbox (unread count) |
| Project | Archived lanes · Project ⚙ (trust, approved scripts, the project's skills/MCP defaults: links to the existing Settings sections, scoped to the project) |
| Help | Keyboard shortcuts (?) |

Rules:
- A button shows its shortcut as a hint when it has one, for example "New lane ⌘⇧L" in the Lane chip's tooltip, or "Search ⌘K".
- **Ask, don't hide.** An action that cannot run stays visible but disabled, and says why:
  - Lane and Fan-out in a folder that is not a git repository: "Not a git repository".
  - Trigger when automation is turned off: "Automation is paused" or the setting's reason.
  - Files and Terminal when the workspace module refuses the root.
- Search opens ⌘K in transcript-search mode with the project's scope.

### 3.3 Status line (one line, every part clickable)

The line reads: `3 active lanes · 1 running task · Inbox 3 · this month $4.20`.

The spend part:
- is owner-wide, says so in its tooltip, and shows "API-equivalent" when the billing mix includes a subscription (finops.md);
- shows "no spend yet" when the month has no runs.

Each part opens its view:
- the lanes in the ⌘B tree, filtered to the project;
- the tasks board;
- the inbox;
- Settings › Usage.

A part with nothing to show (zero lanes, zero tasks) is left out, never shown as "0 …", except the spend.

Sources (existing streams and methods, no new daemon work):
- the lane store (`subscribe.lane`);
- the tasks stream (`subscribe.tasks`);
- the inbox stream (`subscribe.inbox`);
- `usage.summary { range: month }`.

### 3.4 Recent work

- One list for the project. It holds sessions, lanes (active and archived), tasks, and fan-outs (grouped from lanes that share a `fanoutId`).
- Each row has a type chip, a title, a state and a relative time. Rows are ordered by last activity.
- Filter chips: All · Sessions · Lanes · Tasks.
- 20 rows, with "Show more".
- A fan-out row reopens its compare tab (`/compare/<fanoutId>`). This closes the "closed compare cannot be reopened" gap. The compare of a fan-out whose lanes are all archived shows its existing null counts.
- Sources:
  - the sessions list the current home uses;
  - the lane store, plus `lanes.listArchived`;
  - the tasks stream.

### 3.5 "All projects"

- Global actions work: Tasks, Inbox, Search, Shortcuts, Settings.
- The status line and Recent work cover all projects. Rows carry a project chip.
- Launch, in any mode, first opens a project picker popover: the projects, then "Add project…". The mode then continues in the chosen project.

### 3.6 Add project

- **Entry points:** the project chip menu ("Add project…") and the "All projects" picker.
- **Dialog:**
  - one absolute-path field, with a "Check" step that shows the resolved real path and whether it is a git repository;
  - an "Add" button.
  - On success, the chip switches to the new project.
- **Errors:** shown inline, with the daemon's code mapped to EN/FR words.

## 4. Daemon and contract: `projects.add`

```ts
"projects.add": defineMethod({
  name: "projects.add",
  permission: "sessions:operate", // the same as sessions.create, which already creates a project for its folder
  idempotent: true,               // adding an existing root answers that project
  params: z.object({ root: AbsolutePath }),
  result: z.object({ project: ProjectView }),
  errors: ["invalid_cwd", "bad_request", "capacity"],
})
```

- **Validation:** `resolveSessionCwd` (absolute path, real path, directory). Then refuse a root inside `$PAP_HOME`, which holds lane worktrees and pap's data, or inside the Pi agent directory, with `bad_request`.
- **Effect:** `projects.ensure(ownerId, real)`. A full table answers `capacity`; the cap is the existing 2000 projects.
- **Not a new power:** `sessions.create { cwd }` creates the same project today. The `files` roots already follow the owner's projects.
- **Audit:** none. A project row is not an outward effect, and `sessions.create` writes none either.
- **The handler follows AGENTS.md:** decode, one service call, typed errors. The 400-line limit applies.

## 5. The other gaps (decision 85, question 7)

- **Tasks:** an icon in the desktop rail opens the tasks board. Today it is reachable only through the palette.
- **Compare:** reopened from Recent work (§3.4) and from a link in the lane header when the lane belongs to a fan-out.
- **Keyboard shortcuts:** an entry in the account menu and in the home's Help group.
- **Transcript search:** the home's Search button (§3.2).
- **Phone, minimum only:**
  - the logo and a "+" go to the home;
  - Settings and the account are reachable from the Lists tab header menu, without the palette.

## 6. Settings

Settings › Appearance gains a **Home** section with these checkboxes:
- status line;
- each action-row group (Explore, Automate, Project, Help);
- Recent work.

The composer is always shown. The values live in the existing appearance settings store (same persistence and sync). The default shows everything.

## 7. Accessibility

- **Mode chips:** a `radiogroup` with arrow-key movement.
- **Launch:** has an accessible name that includes the mode, for example "Launch a lane".
- **Disabled buttons:** expose their reason through `aria-describedby`.
- **Status line:** its parts are links.
- **Focus:** returns to the composer after a dialog closes without launching.
- **Labels:** `label-hud` for group labels. Tokens only (AGENTS.md UI rules).

## 8. Performance

- **Initial bundle:** must not grow beyond noise (222.7 KB at 04d4871). The New lane dialog, the trigger editor, the tasks board and the Add project dialog stay lazy.
- **Status line:** reads stores that the shell already subscribes to, or subscribes lazily when the home mounts and unsubscribes on unmount. It makes no polling call.

## 9. Testing

- **Web, happy-dom:**
  - each mode's Launch, with the text split into title and description and the clip limits;
  - an empty Launch per mode;
  - the remembered mode;
  - a disabled action showing its reason;
  - "All projects" opening the picker, then continuing in the chosen project;
  - the status line: parts left out at zero, spend wording and the API-equivalent note, each link's target;
  - Recent work: merge order, filters, "Show more", a fan-out row reopening compare;
  - the Settings › Home checkboxes hiding each part;
  - the Add project dialog: check, add, each error code's words;
  - the phone entries;
  - catalog parity (EN/FR).
- **Daemon:**
  - `projects.add` unit tests: validation, refusal inside `$PAP_HOME` and the Pi agent directory, idempotent add, the cap;
  - an integration test over `/ws`: owner scoping, and that a token with `sessions:operate` behaves exactly as `sessions.create` does.
- **Contract:** a pin test for the method, and the permission catalogue entry.
- **Gates:** the full gate with the budgets.

## 10. Rollout

- One milestone-sized change on a branch, merged as one squash commit after the owner's approval.
- No migration.
- The old `SessionListScreen` goes. Its tests move to `ProjectHome`.
