# Project home — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "New session" form with a project home that starts any piece of work (Session, Lane, Fan-out, Trigger) and reaches every project-level view with a visible, clickable control, add "Add project" (`projects.add`), and give the last palette-only and shortcut-only actions a visible entry; shortcuts and ⌘K stay as accelerators.

**Architecture:**
- **Daemon and contract.** One new method, `projects.add` (`sessions:operate`, idempotent): the projects service resolves the folder with sessions' `resolveSessionCwd`, refuses pap's home and Pi's agent folder, files it under `policy.scopeOf` (the rule `sessions.create` already follows) and calls the existing `ensure`. The `shell` snapshot also carries the owner's projects that no session files under yet (`ProjectSummary.unused`), so an added project shows in the chip and survives a reload.
- **Web.** A new feature domain `features/home/`: an eager composer (`ProjectHome`: mode radiogroup, one field, Launch) and one lazy chunk (`HomeBody`: action row, status line, Recent work) with its own lazy catalog. Features never import each other, so everything the home opens goes through a `HomeActions` object the shell builds in `routes/shell/home-actions.ts` and hands in from `routes/shell/HomePane.tsx` (tabs by URL, drawers and dialogs by their commands, prefills by small stores). The New lane dialog, the trigger editor and the palette are reused; they gain only an optional prefill field (title, name and prompt) and a search-only mode. Add project is a lazy dialog in `features/projects/`, opened from the chip menu and from the "All projects" picker through `stores/add-project-request.ts`.
- **Settings.** `AccountAppearance.home` (six booleans, all shown by default) in the existing appearance document; Settings › Appearance gains a Home section.

**Tech Stack:** Node 24, pnpm, TypeScript 6.0.3 strict and erasable-only, zod 4, Hono, `ws`, `node:sqlite`, React 19 + Vite + React Compiler, TanStack Router, zustand, Tailwind 4, Vitest + happy-dom. **No new dependency** (one more lucide icon re-exported by `@pap/ui`).

**Spec:** `docs/specs/2026-10-15-project-home-design.md` (decision 85; question page `docs/design/questions/2026-10-15-project-home.html`, answers `…-answers.json`). Also read: `AGENTS.md`, `docs/agents/web.md`, `docs/agents/sessions.md`, `docs/agents/lanes.md`, `docs/agents/automation.md`, `docs/agents/finops.md`, and the action inventory `.superpowers/brainstorm-launcher/inventory.md`.

## Global Constraints

Every task's requirements include these. Copied from the spec and `AGENTS.md`.

- **400 lines per file at most. No baseline, no exceptions.**
- **A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`.**
- **Every RPC method declares a permission in `packages/contracts/src/methods.ts`.** (`projects.add` joins `shellMethods`, which `methods.ts` spreads, as `projects.update` does.)
- **RPC handlers decode, call one service method, map typed errors. Nothing else.**
- **UI code uses tokens from `packages/ui/src/tokens.css`: no raw colours, no `[…]` arbitrary values, no restyling of `@pap/ui` primitives.** Spacing uses the `s1`–`s6` steps (`gap-s2`, `p-s3`), never a number (`pap/no-numeric-spacing`). No native `title` attribute (`pap/no-native-title`). Group labels use `label-hud`.
- **The only ESLint directive accepted is `eslint-disable-next-line <rule> -- <reason>`.**
- **TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep their `.ts` extension.**
- **Tests never touch `~/.pi/agent` or `~/.pap`; timers go through the kernel `Clock`; no sleeps.**
- **Never edit pi-web; pap imports nothing from it.**
- **Web boundaries (web.md):** features import no other feature; a feature reaches another through the shell (`routes/shell`) by props and callbacks, or through `stores/`. Lazy-only code is imported from its own file, never a feature `index.ts`.
- **Conventional Commits; no AI attribution trailers.** Each task ends with one commit; the branch is squashed into one commit after the owner's approval (spec §10).
- **Spec §4, verbatim:**
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
  Validation: `resolveSessionCwd` (absolute path, real path, directory), then refuse a root inside `$PAP_HOME` or inside the Pi agent directory with `bad_request`. A full table answers `capacity` (the existing 2000). **Audit: none.**
- **Spec §8 Performance:** "**Initial bundle:** must not grow beyond noise (222.7 KB at 04d4871). The New lane dialog, the trigger editor, the tasks board and the Add project dialog stay lazy." Noise is taken as **+1.0 KB gzip: the initial bundle stays at or under 223.7 KB** (`pnpm build && pnpm budgets`), measured at the JOIN, after Task 11 and at Task 12. Over it: move code into a lazy chunk before the review; if that cannot be done, stop and ask the owner. "**Status line:** reads stores that the shell already subscribes to, or subscribes lazily when the home mounts and unsubscribes on unmount. It makes no polling call."
- **Spec §3.2 "Ask, don't hide":** an action that cannot run stays visible but disabled and says why; the reason is visible text, linked by `aria-describedby`.
- **Spec §7 Accessibility:** mode chips are a `radiogroup` with arrow-key movement; Launch's accessible name includes the mode ("Launch a lane"); disabled buttons expose their reason through `aria-describedby`; status-line parts are links; focus returns to the composer after a dialog closes without launching.
- **Non-goals (§2):** no mobile redesign beyond §5's minimum (M12), no GitHub clone/fork/tokens (decision 84), no per-project spend, no change to the New lane dialog or the trigger editor beyond the prefill hand-off. **No migration** (§10).
- Test commands: `pnpm exec vitest run --project unit <file>`; `pnpm exec vitest run --project integration <file>`. Gates: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm knip`, `pnpm test:unit`, `pnpm test:int`, `pnpm build && pnpm budgets`.

## Review Focus

Five inputs the spec implies but its own test list does not pin; most likely to bite first. Each line's test lives in the named task.

1. **A Session launch whose `sessions.create` succeeds but whose first `sessions.prompt` is refused or times out** → the new session still opens and the typed text is waiting in its composer, never lost (Task 10, `ProjectHome.test.tsx` "keeps the text in the new session's composer when the first message does not go").
2. **A launch text whose first line is blank, holds bidi or zero-width characters, ends in `\r`, or is longer than the title limit in emoji** → the lane title and the trigger name are the first visible line, cleaned, clipped without splitting a surrogate pair, and accepted by `LaneTitle` / `TriggerName` (Task 5, `launch-text.test.ts`).
3. **Enter pressed while an input method is composing, and Enter on a phone** → never launches; a phone keyboard has no Shift, so Enter is a new line there and the button launches (Task 10, `ProjectHome.modes.test.tsx` "an input method's Enter never launches; a phone's Enter is a new line").
4. **`projects.add` given a symlink into `$PAP_HOME` or the Pi agent folder, a trailing slash, or a `..` segment** → the link is refused `bad_request`; the other spellings answer the one project of the real folder (Task 1, `service.add.test.ts`).
5. **Recent work over a lane or task whose session is also in the shell store, and a fan-out whose lanes are split between live and archived** → one row per lane, task and fan-out, no duplicate session rows (Task 8, `recent-work.vm.test.ts` "does not list a lane's or a task's session twice…").

## Spec rulings (ambiguities resolved here)

- **PH1 — `projects.add` files the folder under its scope.** §4 says `projects.ensure(ownerId, real)` and also "Not a new power: `sessions.create { cwd }` creates the same project today". `sessions.create` files a folder under `policy.scopeOf(cwd)` (its git root, else itself). Storing the raw real path would make a home Launch in `/repo/src` file its session under another project (`/repo`). So `add` calls `ensure(owner, scopeOf(real))`, and refuses both the real path and the scope inside pap's home or Pi's agent folder.
- **PH2 — Check without a dry run.** §4 has one method and no dry run, so the dialog's "Check" calls `projects.add` (idempotent; a project row is not an outward effect, §4) and then `lanes.preview` for "is a git repository"; "Add" switches the chip. A folder checked and then cancelled stays in the list.
- **PH3 — An added project must show in the chip and survive a reload.** The owner's answer (question 4: "le projet apparaît tout de suite dans la puce. On ne passe plus par « ouvrir une session »") cannot hold with today's snapshot, which lists only projects with an active session (M4 Q15) and a switcher that hides `sessions === 0`. The snapshot also lists the owner's projects that no session files under at all, flagged `unused: true` on `ProjectSummary`; the switcher and the picker list `sessions > 0 || unused`. Residual: re-adding a project whose sessions are all archived holds for the page only (it is "used", not active).
- **PH4 — Spend range.** `usage.summary` has no `month` range and §3.3 says "no new daemon work": the part uses `30d` and says "30 days $4.20".
- **PH5 — "Settings › Usage"** does not exist: spending lives in Settings › Automation (decision 81); the spend part opens `/settings/automation`.
- **PH6 — Keys.** §3.1 says "Enter launches and Shift+Enter adds a new line, the same as the session composer", but the session composer submits with Ctrl/⌘+Enter. The home does what §3.1 spells out (Enter launches, Shift+Enter new line), also accepts Ctrl/⌘+Enter, never launches during an IME composition, and on a phone Enter is a new line (no Shift there; the button launches).
- **PH7 — Lane split.** Title = the first visible line, clipped to `LANE_LIMITS.title`; description = the remaining lines, or the whole text when there is only one line (`lanes.create` needs a description; the lane's first prompt is `# title\n\ndescription`, so nothing is lost). The dialog gets the title through an optional `title` on the existing `NewLanePrefill`; the trigger editor gets name and prompt through an optional `prefill` prop. Both are hand-off fields, not dialog changes (§2).
- **PH8 — Search scope.** `search.query` has no project filter and §3 forbids daemon work: the palette gains a search-only mode and filters the 20 hits to the project on the client. Residual: a project's hits can be crowded out by other projects' hits.
- **PH9 — Project ⚙.** Links to Settings › Skills (with the trust review), › MCP and › Approvals, which read the switcher's project. Lane script approval has no Settings section: it stays in the New lane dialog (the Lane chip).
- **PH10 — Status-line parts are links where a URL exists.** Tasks (`/tasks`) and spend (`/settings/automation`) are `<a href>`; lanes (the ⌘B tree) and Inbox (the drawer) open drawers with no URL, so they are buttons styled like the links.
- **PH11 — Inbox counts** are the owner's unread items (inbox items carry no project), in the action row and the status line.
- **PH12 — Unknown facts never disable.** Lane and Fan-out stay enabled until `lanes.preview` answers `repo: false`; Files and Terminal until `files.list` on the root is refused. Trigger is disabled while automation is paused, or while the daily budget is $0 ("the setting's reason").
- **PH13 — "All projects".** Launch opens a picker (a lazy inline panel under the composer: the listed projects, then "Add project…"). Picking a project launches there at once, without moving the chip; "Add project…" opens the dialog and, on Add, the chip switches and the launch goes on in the new project. In "All projects", Files and Terminal say "Choose a project first."; Tasks, Inbox, Search, Shortcuts, Archived lanes and Project ⚙ work.
- **PH14 — Modes.** The last mode chosen is remembered per device (`pap.home.mode.v1`) when it is chosen. A remembered mode the current project refuses shows Session checked for this project; the stored choice stays for the others. Fan-out presets two model slots even for an empty launch.
- **PH15 — `read_only`.** The service maps a refused write of a database a newer pap wrote to `read_only` (as the automation methods do), so the contract declares it after the spec's three codes: `["invalid_cwd", "bad_request", "capacity", "read_only"]`.

## Spec coverage

| Spec | Tasks |
|---|---|
| §3 route, `ProjectHome` replaces `SessionListScreen` | 10 |
| §3.1 composer, modes, Launch per mode, empty launch, Options | 5, 10 |
| §3.2 action row, shortcut hints, ask-don't-hide, Search mode | 6, 11 |
| §3.3 status line | 7, 11 |
| §3.4 Recent work, fan-out reopens compare | 8, 11 |
| §3.5 All projects | 2, 10 |
| §3.6 Add project | 2, 3 |
| §4 `projects.add` | 1 |
| §5 Tasks rail icon, lane Compare link, shortcuts in account menu, phone minimum | 9 (search: 6, 11) |
| §6 Settings › Appearance › Home | 4, 11 |
| §7 accessibility | 10, 11 (each test file) |
| §8 performance | 3, 11, 12 |
| §9 tests | every task |
| §10 rollout, tests move | 10, 12 |

---

## File Structure

Daemon and contracts (track 1):

| File | Responsibility |
|---|---|
| `packages/contracts/src/shell.ts` (modify) | `ProjectView`, `ProjectSummary.unused`, `projects.add` |
| `packages/contracts/src/settings.ts` (modify) | `HOME_PARTS`, `HomeLayout`, `DEFAULT_HOME_LAYOUT`, `AccountAppearance.home` |
| `apps/daemon/src/modules/projects/service.ts` (modify) | `ProjectFolders`, `add`, `all` |
| `apps/daemon/src/modules/projects/rpc.ts`, `index.ts` (modify) | the `projects.add` handler; `folders` dep; `ProjectsPort.all` |
| `apps/daemon/src/daemon.ts` (modify) | passes `folders` (resolve, scope, state folders) |
| `apps/daemon/src/modules/sessions/marks-store.ts`, `service-shell.ts`, `testing/fake-projects.ts` (modify) | projects in use; `unused` in the snapshot and events |

Web (both tracks):

| File | Responsibility | Task |
|---|---|---|
| `apps/web/src/stores/current-project.ts` (modify) | `listedProjects` (switcher and picker list) | 2 |
| `apps/web/src/stores/add-project-request.ts` (create) | open state and continuation of the Add project dialog | 3 |
| `apps/web/src/stores/shell-store.ts` (modify) | `holdProject` (an RPC's project held until the stream speaks) | 3 |
| `apps/web/src/features/projects/AddProjectDialog.tsx`, `add-project.vm.ts`, `register-add-project-catalog.ts` (create) | the lazy dialog, its words | 3 |
| `apps/web/src/routes/shell/AddProjectHost.tsx` (create) | mounts the dialog, switches the chip | 3 |
| `apps/web/src/i18n/catalog/add-project.ts` (create) | lazy catalog `addProject.*` | 3 |
| `apps/web/src/features/appearance/HomeSection.tsx` (create) | Settings › Appearance › Home | 4 |
| `apps/web/src/features/home/launch-text.ts` (create) | split a launch text into title / description / name / prompt | 5 |
| `apps/web/src/stores/trigger-prefill.ts` (create) | name and prompt waiting for a new trigger's editor | 5 |
| `apps/web/src/stores/palette-request.ts` (create) | the next palette opening is transcript search | 6 |
| `apps/web/src/features/home/home-actions.ts` (create) | `HomeTarget`, `HomeActions`, `HomeShortcuts` types | 7 |
| `apps/web/src/features/home/status-line.vm.ts`, `use-spend.ts`, `StatusLine.tsx` (create) | §3.3 | 7 |
| `apps/web/src/i18n/catalog/home.ts`, `apps/web/src/i18n/register-home.ts` (create) | lazy catalog `home.*` | 7 |
| `apps/web/src/testing/home-actions.ts`, `home-fixtures.ts` (create) | test helpers | 7 |
| `apps/web/src/features/home/recent-work.vm.ts`, `use-archived-lanes.ts`, `RecentWork.tsx` (create) | §3.4 | 8 |
| `apps/web/src/routes/shell/MobileListsMenu.tsx` (create) | the phone's Settings and account menu | 9 |
| `apps/web/src/features/home/home-mode.ts`, `project-facts.ts`, `use-launch.ts`, `ModeChips.tsx`, `ProjectHome.tsx`, `ProjectPicker.tsx` (create) | the eager composer, the lazy picker | 10 |
| `apps/web/src/i18n/catalog/launch.ts` (create) | eager catalog `launch.*` | 10 |
| `apps/web/src/routes/shell/HomePane.tsx`, `home-actions.ts` (create) | the host: actions, chords, preset field, tasks feed | 10 |
| `apps/web/src/testing/home-bed.tsx` (create) | mounts `ProjectHome` with two projects for the composer tests | 10 |
| `apps/web/src/features/sessions/SessionListScreen.tsx` and its 2 tests (delete) | replaced | 10 |
| `apps/web/src/features/home/ActionRow.tsx`, `use-root-access.ts`, `HomeBody.tsx` (create) | §3.2, the lazy body | 11 |

## Parallel tracks and the JOIN

Two worktrees, each its own branch off `main` (`feat/project-home` for track 1, `feat/project-home-web` for track 2).

| Track | Tasks | Owns |
|---|---|---|
| 1 — daemon, contracts, core web | 1 → 2 → 3 → 4 | `packages/contracts`, `apps/daemon`, `ProjectSwitcher`, `AddProjectHost`, `features/projects/AddProject*`, `features/appearance` |
| 2 — web that needs none of track 1's code | 5 → 6 → 7 → 8 → 9 | `features/home/{launch-text,home-actions,status-line*,StatusLine,use-spend,recent-work*,RecentWork,use-archived-lanes}`, palette, `features/lanes` hand-off and Compare link, `features/automation` prefill, Rail, `MobileShell` |

**JOIN (after Tasks 4 and 9):** merge `feat/project-home-web` into `feat/project-home`, then run every gate there. What the JOIN reconciles:
- `apps/web/src/i18n/index.ts` — the `MessageKey` union and its type imports: track 1 adds `addProjectEn` (Task 3), track 2 adds `homeEn` (Task 7). Keep both lines of each.
- `apps/web/src/i18n/catalog-keys.test.ts` — both tracks add a catalog to the English and the French lists (`addProject`, `home`). Keep both.
- `apps/web/src/i18n/catalog/shell.ts` — track 1 adds `shell.project.add` (Task 3); track 2 adds `shell.rail.tasks`, `shell.rail.shortcuts`, `shell.mobile.more` (Task 9), each in the English and the French object. Keep all, in both objects.
- `apps/web/src/routes/shell/AppShell.tsx` (shell wiring) — track 1 mounts `<AddProjectHost />` (Task 3); track 2 resets the trigger prefill store at sign-out (Task 5). Keep both.
- Then: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm knip`, `pnpm test:unit`, `pnpm test:int`, `pnpm build && pnpm budgets` (initial ≤ 223.7 KB; record the number in the JOIN commit body). Commit: `chore: join the project home tracks`.

Tasks 10 → 11 → 12 run on the joined `feat/project-home` (shown as track "J").

## Model table

| Task | Track | Implementer | Reviewer | Why |
|---|---|---|---|---|
| 1 `projects.add` | 1 | Sonnet | **Opus** | It widens what the `files`, `vcs` and terminal roots cover; a wrong path check makes `$PAP_HOME` (lane worktrees, secrets) or Pi's agent folder a browsable project root: a security hole. |
| 2 Projects with no session yet | 1 | Sonnet | Sonnet | The candidate list comes from the owner-filtered `projects.list`; the new query can only hide a project, never leak one; a two-owner test pins it. |
| 3 Add project dialog | 1 | Sonnet | Sonnet | Web only; shows the daemon's codes. |
| 4 Settings › Home | 1 | Sonnet | Sonnet | One field read field by field; a test pins that an older document keeps its custom themes. |
| 5 Launch hand-offs | 2 | Sonnet | Sonnet | Pure text functions and two optional prefill fields. |
| 6 Palette search mode | 2 | Sonnet | Sonnet | Client-side filter of existing hits; text rendering unchanged. |
| 7 Status line | 2 | Sonnet | Sonnet | Reads stores and one summary call. |
| 8 Recent work | 2 | Sonnet | Sonnet | A pure merge over stores. |
| 9 Shell gaps | 2 | Sonnet | Sonnet | Visible entries for existing commands. |
| 10 Project home composer | J | Sonnet | Sonnet | Launch logic over existing methods; Review Focus 1 pins the one data-loss path (the typed text). |
| 11 Home body | J | Sonnet | Sonnet | Assembly, lazy chunk, bundle check. |
| 12 Docs and the full gate | J | Sonnet | Sonnet | Notes and gates. |
| Whole branch, before the squash | — | — | **Opus** | Cross-task names, the JOIN, the bundle number, the security of Task 1 in context. |

No Haiku.

---
### Task 1: `projects.add` (contract, service, handler, composition)

Track 1. Spec §4, §9 (daemon, contract). Rulings PH1. Review Focus 4.

**Files:**
- Modify: `packages/contracts/src/shell.ts` (`ProjectView`, `AbsolutePath`, the method)
- Modify: `packages/contracts/src/shell.test.ts`
- Modify: `apps/daemon/src/modules/projects/service.ts` (whole file below)
- Modify: `apps/daemon/src/modules/projects/rpc.ts`, `rpc.test.ts`, `index.ts`
- Modify: `apps/daemon/src/daemon.ts:33` (import) and `:185` (composition)
- Create: `apps/daemon/src/modules/projects/service.add.test.ts`
- Modify: `apps/daemon/src/daemon.projects.int.test.ts`

**Interfaces:**
- Consumes: `resolveSessionCwd(input: string): string` (`modules/sessions/index.ts`), `PolicyPort.scopeOf(cwd: string): string`, `within(root: string, target: string): boolean` (`kernel/fs/boundary.ts`), `Config.home`, `Config.piAgentDir`.
- Produces:
  - contracts `ProjectView = z.object({ id, root, name, position })`, `type ProjectView`; `ProjectSummary = ProjectView.extend({ sessions })` (same shape as before); method `"projects.add"` with `ParamsOf<"projects.add"> = { root: string }`, `ResultOf<"projects.add"> = { project: ProjectView }`.
  - daemon `interface ProjectFolders { resolve(input: string): string; scopeOf(real: string): string; readonly stateDirs: readonly string[] }` exported from `modules/projects/index.ts`; `createProjectsModule(deps: { db; clock; logger; newId(); folders?: ProjectFolders })`; `ProjectsService.add(caller: Caller, root: string): ProjectView`.

- [ ] **Step 1: Write the failing contract test**

Append to `packages/contracts/src/shell.test.ts`:

```ts
describe("projects.add (decision 85)", () => {
  it("is the idempotent sessions:operate method the home's Add project calls, with its three refusals", () => {
    expect(methods["projects.add"]).toMatchObject({
      name: "projects.add",
      permission: "sessions:operate",
      idempotent: true,
      errors: ["invalid_cwd", "bad_request", "capacity", "read_only"],
    });
    const { params, result } = methods["projects.add"];
    expect(params.safeParse({ root: "/w/api" }).success).toBe(true);
    for (const root of ["", "w/api", "/a\u0000b", `/${"a".repeat(4096)}`, 4])
      expect(params.safeParse({ root }).success, String(root)).toBe(false);
    expect(result.safeParse({ project: { id: "p1", root: "/w/api", name: "api", position: -1 } }).success).toBe(
      true,
    );
    expect(result.safeParse({ project: { id: "p1", root: "/w/api", name: "api" } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run --project unit packages/contracts/src/shell.test.ts`
Expected: FAIL — `methods["projects.add"]` is undefined.

- [ ] **Step 3: Add the contract**

In `packages/contracts/src/shell.ts`, replace the `ProjectSummary` declaration (lines 29–42) with:

```ts
/** An absolute path as a caller writes it; the daemon resolves it (`invalid_cwd`). */
const AbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "an absolute path");

/** A project as `projects.add` answers it (decision 85). */
export const ProjectView = z.object({
  id: Id,
  /** The git root of its sessions' folder, or that folder outside git (`policy.scopeOf`, M2R68). */
  root: z.string().min(1).max(4096),
  name: z
    .string()
    .min(1)
    .max(SHELL_LIMITS.projectName * 2),
  /** The person's order: lower first (fractional, so a move rewrites one row). */
  position: z.number().finite(),
});
export type ProjectView = z.infer<typeof ProjectView>;

export const ProjectSummary = ProjectView.extend({
  /** Its sessions that are not archived. */
  sessions: z.number().int().nonnegative(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;
```

Then add, as the first entry of `shellMethods`:

```ts
  "projects.add": defineMethod({
    name: "projects.add",
    permission: "sessions:operate", // the same as sessions.create, which already creates a project for its folder
    idempotent: true, // adding an existing root answers that project
    params: z.object({ root: AbsolutePath }),
    result: z.object({ project: ProjectView }),
    // `invalid_cwd`: not an existing folder; `bad_request`: inside pap's home or Pi's agent folder; `capacity`: 2000 projects; `read_only`: a database a newer pap wrote (PH15).
    errors: ["invalid_cwd", "bad_request", "capacity", "read_only"],
  }),
```

- [ ] **Step 4: Run the contract tests**

Run: `pnpm exec vitest run --project unit packages/contracts/src/shell.test.ts packages/contracts/src/methods.test.ts`
Expected: PASS (`projects.add` is idempotent, so the mutation list in `methods.test.ts` does not change).

- [ ] **Step 5: Write the failing service tests**

Create `apps/daemon/src/modules/projects/service.add.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { resolveSessionCwd } from "../sessions/index.ts";
import { createProjectsService, MAX_PROJECTS, type ProjectFolders } from "./service.ts";
import { createProjectsStore } from "./store.ts";
import { createProjectsBed } from "./testing/bed.ts";

let bed: ReturnType<typeof createProjectsBed>;
let dir: string;
let folders: ProjectFolders;
const at = (...parts: string[]) => join(dir, ...parts);
const u1 = testCaller({ userId: "u1" });

const build = (rules: ProjectFolders | null = folders) =>
  createProjectsService({
    store: createProjectsStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: bed.newId,
    ...(rules === null ? {} : { folders: rules }),
  });

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : "other";
  }
  return undefined;
};

beforeEach(() => {
  bed = createProjectsBed();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-add-")));
  for (const folder of ["work/repo/.git", "work/repo/src", "work/plain", "pap/worktrees/lane-1a2b", "agent/sessions"])
    mkdirSync(at(folder), { recursive: true });
  writeFileSync(at("work", "notes.txt"), "x");
  symlinkSync(at("pap"), at("work", "to-pap"));
  symlinkSync(at("agent", "sessions"), at("work", "to-agent"));
  folders = {
    resolve: resolveSessionCwd,
    // What `policy.scopeOf` answers here: the repository root for a folder inside it, else the folder.
    scopeOf: (real) =>
      real === at("work", "repo") || real.startsWith(`${at("work", "repo")}/`) ? at("work", "repo") : real,
    stateDirs: [at("pap"), at("agent")],
  };
});
afterEach(() => {
  bed.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("projects.add (decision 85)", () => {
  it("files a folder under its git root, named after it, and answers one project for every spelling of it", () => {
    const projects = build();
    const repo = projects.add(u1, at("work", "repo", "src"));
    expect(repo).toMatchObject({ root: at("work", "repo"), name: "repo" });
    expect(projects.add(u1, at("work", "repo")).id).toBe(repo.id);
    const plain = projects.add(u1, at("work", "plain"));
    expect(plain.root).toBe(at("work", "plain"));
    // Review Focus 4: a trailing slash and a `..` segment are the same real folder, so the same project.
    expect(projects.add(u1, `${at("work", "plain")}/`).id).toBe(plain.id);
    expect(projects.add(u1, `${at("work", "repo")}/../plain`).id).toBe(plain.id);
    expect(projects.list("u1", [repo.id, plain.id])).toHaveLength(2);
  });

  it("answers invalid_cwd for a relative, home-relative, missing or file path", () => {
    const projects = build();
    for (const root of ["work/plain", "~/plain", at("work", "missing"), at("work", "notes.txt")])
      expect(codeOf(() => projects.add(u1, root)), root).toBe("invalid_cwd");
  });

  it("refuses pap's home, Pi's agent folder, anything inside them and a link into them (Review Focus 4)", () => {
    const projects = build();
    for (const root of [
      at("pap"),
      at("pap", "worktrees", "lane-1a2b"),
      at("agent"),
      at("agent", "sessions"),
      at("work", "to-pap"),
      at("work", "to-agent"),
    ])
      expect(codeOf(() => projects.add(u1, root)), root).toBe("bad_request");
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM projects")?.n).toBe(0);
  });

  it("answers capacity past MAX_PROJECTS, and still answers a project the owner already has", () => {
    const store = createProjectsStore(bed.db);
    // One transaction: 2 000 autocommits are 2 000 fsyncs (M4R130).
    bed.db.transaction(() => {
      for (let i = 0; i < MAX_PROJECTS - 1; i++)
        store.insert({ id: `x${i}`, ownerId: "u1", root: `/r/${i}`, name: `r${i}`, position: i, createdAt: 0 });
      store.insert({ id: "kept", ownerId: "u1", root: at("work", "plain"), name: "plain", position: 0, createdAt: 0 });
    });
    const projects = build();
    expect(codeOf(() => projects.add(u1, at("work", "repo")))).toBe("capacity");
    expect(projects.add(u1, at("work", "plain")).id).toBe("kept");
  });

  it("keeps owners apart: one folder is one project per owner", () => {
    const projects = build();
    const mine = projects.add(u1, at("work", "plain"));
    const theirs = projects.add(testCaller({ userId: "u2" }), at("work", "plain"));
    expect(theirs.id).not.toBe(mine.id);
    expect(projects.list("u1", [theirs.id])).toEqual([]);
  });

  it("maps a refused write of a newer database to read_only", () => {
    const store = createProjectsStore(bed.db);
    const projects = createProjectsService({
      store: {
        ...store,
        insert: () => {
          throw new Error("attempt to write a readonly database");
        },
      },
      clock: bed.clock,
      logger: bed.logger,
      newId: bed.newId,
      folders,
    });
    expect(codeOf(() => projects.add(u1, at("work", "plain")))).toBe("read_only");
  });

  it("fails closed without the folder rules", () => {
    expect(codeOf(() => build(null).add(u1, at("work", "plain")))).toBe("internal");
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm exec vitest run --project unit apps/daemon/src/modules/projects/service.add.test.ts`
Expected: FAIL — `ProjectFolders` is not exported and `add` is not a function.

- [ ] **Step 7: Implement `add`**

Replace `apps/daemon/src/modules/projects/service.ts` with:

```ts
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { type Caller, PapError, type ProjectChange, SHELL_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import { within } from "../../kernel/fs/boundary.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { cleanLabel } from "../../kernel/text.ts";
import type { ProjectRow, ProjectsStore } from "./store.ts";

/** Projects per owner (M4R22). */
export const MAX_PROJECTS = 2000;
const MAX_ROOT = 4096;
/** Two neighbours closer than this are renumbered 1..n (M4R21). */
const MIN_GAP = 1e-6;

export interface ProjectView {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly position: number;
}

/**
 * How `projects.add` reads a folder (decision 85), given by the composition: the rules `sessions.create` follows, so
 * adding a folder makes exactly the project a session in it would make (PH1).
 */
export interface ProjectFolders {
  /** The real path of an existing folder; `invalid_cwd` for anything else (sessions' `resolveSessionCwd`). */
  resolve(input: string): string;
  /** The project a real folder files under: its git root, else itself (`policy.scopeOf`, M2R68). */
  scopeOf(real: string): string;
  /** pap's home (lane worktrees, secrets, the database) and Pi's agent folder: no project lives inside them. */
  readonly stateDirs: readonly string[];
}

const viewOf = (row: ProjectRow): ProjectView => ({
  id: row.id,
  root: row.root,
  name: row.name,
  position: row.position,
});
// C0 controls, NUL included: a root is a real path, and a path with a control character is not one pap makes a project of.
const hasControl = (text: string): boolean => [...text].some((char) => (char.codePointAt(0) ?? 0x20) < 0x20);
// A path to compare lexically: absolute, no NUL, no empty, `.` or `..` segment, no trailing slash.
const isCleanPath = (path: string): boolean =>
  path.startsWith("/") &&
  !path.includes("\0") &&
  (path === "/" ||
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."));
const defaultName = (root: string): string =>
  cleanLabel(basename(root), SHELL_LIMITS.projectName) ?? cleanLabel(root, SHELL_LIMITS.projectName) ?? "/";
/** A state folder as it really is (a link resolved), or its absolute form when it does not exist yet. */
const realOrResolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function createProjectsService(deps: {
  readonly store: ProjectsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Absent: `add` refuses with `internal` (fail closed). The daemon always gives it. */
  readonly folders?: ProjectFolders;
  newId(): string;
}) {
  const listeners = new Set<(ownerId: string, project: ProjectView) => void>();
  const limiter = createRateLimiter(deps.clock, 60_000);
  // A listener that fails (the shell publisher, say) must not stop the others nor fail the change that called it.
  const changed = (ownerId: string, project: ProjectView) => {
    for (const listener of [...listeners]) {
      try {
        listener(ownerId, project);
      } catch (error) {
        deps.logger.warn("projects_listener_failed", { err: error });
      }
    }
  };
  const owned = (ownerId: string, id: string): ProjectRow => {
    const row = deps.store.get(ownerId, id);
    if (!row) throw new PapError("not_found");
    return row;
  };

  /** The fractional position that puts a project before `before` (last when null or unknown), or null when too tight. */
  function placeBefore(ownerId: string, id: string, before: string | null): number | null {
    const order = deps.store.list(ownerId).filter((row) => row.id !== id);
    const at = before === null ? -1 : order.findIndex((row) => row.id === before);
    if (at === -1) return (order.at(-1)?.position ?? 0) + 1;
    const next = order[at] as ProjectRow;
    const previous = order[at - 1];
    if (!previous) return next.position - 1;
    const position = (previous.position + next.position) / 2;
    return next.position - previous.position < MIN_GAP ? null : position;
  }

  function applyUpdate(caller: Caller, projectId: string, change: ProjectChange): void {
    const row = owned(caller.userId, projectId);
    if (change.kind === "rename") {
      const name = cleanLabel(change.name, SHELL_LIMITS.projectName);
      if (name === null) throw new PapError("bad_request");
      deps.store.rename(caller.userId, row.id, name);
      changed(caller.userId, viewOf(owned(caller.userId, row.id)));
      return;
    }
    const position = placeBefore(caller.userId, row.id, change.before);
    if (position !== null) {
      deps.store.setPosition(caller.userId, row.id, position);
      changed(caller.userId, viewOf(owned(caller.userId, row.id)));
      return;
    }
    // Too tight to split: renumber the order with the project in its new place, and publish every position.
    const order = deps.store
      .list(caller.userId)
      .map((project) => project.id)
      .filter((id) => id !== row.id);
    const at = change.before === null ? -1 : order.indexOf(change.before);
    order.splice(at === -1 ? order.length : at, 0, row.id);
    deps.store.renumber(caller.userId, order);
    for (const project of deps.store.list(caller.userId)) changed(caller.userId, viewOf(project));
  }

  /** The owner's project for `root`, made on first use at the top; null for a root it cannot use or a full table. */
  function ensure(ownerId: string, root: string): ProjectView | null {
    if (!isAbsolute(root) || root.length > MAX_ROOT || hasControl(root)) return null;
    const found = deps.store.byRoot(ownerId, root);
    if (found) return viewOf(found);
    if (deps.store.count(ownerId) >= MAX_PROJECTS) {
      const said = limiter.check("projects_full");
      if (said.allowed) deps.logger.warn("projects_full", { max: MAX_PROJECTS, suppressed: said.suppressed });
      return null;
    }
    const row: ProjectRow = {
      id: deps.newId(),
      ownerId,
      root,
      name: defaultName(root),
      position: (deps.store.firstPosition(ownerId) ?? 0) - 1,
      createdAt: deps.clock.now(),
    };
    deps.store.insert(row);
    const view = viewOf(row);
    changed(ownerId, view);
    return view;
  }

  /**
   * `projects.add` (decision 85): the folder's project, made when it is new, the same one when it exists. The real path
   * and its scope are both refused inside pap's home or Pi's agent folder, whatever link led there (Review Focus 4).
   */
  function add(caller: Caller, root: string): ProjectView {
    const folders = deps.folders;
    if (folders === undefined) throw new PapError("internal");
    const real = folders.resolve(root);
    const scope = folders.scopeOf(real);
    const states = folders.stateDirs.map(realOrResolved);
    if ([real, scope].some((path) => states.some((state) => within(state, path)))) throw new PapError("bad_request");
    if (!isAbsolute(scope) || scope.length > MAX_ROOT || hasControl(scope)) throw new PapError("bad_request");
    try {
      const view = ensure(caller.userId, scope);
      if (view === null) throw new PapError("capacity");
      return view;
    } catch (error) {
      // A database a newer pap wrote refuses the write: a typed error, not SQLite's message.
      throw isReadOnlyError(error) ? new PapError("read_only") : error;
    }
  }

  return {
    ensure,
    add,
    /** True when `path` is one of the owner's project roots or lies inside one (what a session's folder is filed under). */
    covers(ownerId: string, path: string): boolean {
      if (!isCleanPath(path)) return false;
      return deps.store
        .list(ownerId)
        .some(
          (row) => path === row.root || path.startsWith(row.root.endsWith("/") ? row.root : `${row.root}/`),
        );
    },
    list: (ownerId: string, ids: readonly string[]): ProjectView[] =>
      deps.store.byIds(ownerId, ids).map(viewOf),
    /** Every root of the owner, as stored, newest first: what the file boundary judges paths against (M8R15). */
    roots: (ownerId: string): string[] => deps.store.roots(ownerId),
    update(caller: Caller, projectId: string, change: ProjectChange): void {
      try {
        applyUpdate(caller, projectId, change);
      } catch (error) {
        // A database a newer pap wrote refuses the write: a typed error, not SQLite's message.
        throw isReadOnlyError(error) ? new PapError("read_only") : error;
      }
    },
    onChange(listener: (ownerId: string, project: ProjectView) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type ProjectsService = ReturnType<typeof createProjectsService>;
```

- [ ] **Step 8: Run the service tests**

Run: `pnpm exec vitest run --project unit apps/daemon/src/modules/projects/`
Expected: PASS (the existing `service.test.ts` still passes: `ensure` keeps its behaviour).

- [ ] **Step 9: Write the failing handler test**

Append inside the `describe("projects rpc", …)` block of `apps/daemon/src/modules/projects/rpc.test.ts`:

```ts
  it("answers projects.add with the service's project for the caller", async () => {
    const view = { id: "p1", root: "/w/api", name: "api", position: -1 };
    const add = vi.fn(() => view);
    const rpc = projectsRpc({ add } as unknown as ProjectsService);
    expect(await rpc["projects.add"]({ root: "/w/api/src" }, ctx)).toEqual({ project: view });
    expect(add).toHaveBeenCalledExactlyOnceWith(caller, "/w/api/src");
  });
```

Run: `pnpm exec vitest run --project unit apps/daemon/src/modules/projects/rpc.test.ts`
Expected: FAIL — `rpc["projects.add"] is not a function`.

- [ ] **Step 10: Add the handler, the module dep and the composition**

`apps/daemon/src/modules/projects/rpc.ts`:

```ts
import type { HandlerTable } from "@pap/contracts";
import type { ProjectsService } from "./service.ts";

export type ProjectsRpc = Pick<HandlerTable, "projects.update" | "projects.add">;

export function projectsRpc(service: ProjectsService): ProjectsRpc {
  return {
    "projects.update": async ({ projectId, change }, ctx) => {
      service.update(ctx.caller, projectId, change);
      return { ok: true as const };
    },
    "projects.add": async ({ root }, ctx) => ({ project: service.add(ctx.caller, root) }),
  };
}
```

`apps/daemon/src/modules/projects/index.ts`: change the service import and type export, and the factory:

```ts
import { createProjectsService, type ProjectFolders, type ProjectView } from "./service.ts";
import { createProjectsStore } from "./store.ts";

export type { ProjectFolders, ProjectView } from "./service.ts";
```

```ts
export function createProjectsModule(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `projects.add`'s folder rules (the daemon passes them; test beds that never add may leave them out). */
  readonly folders?: ProjectFolders;
  newId(): string;
}): ProjectsModule {
  const service = createProjectsService({
    store: createProjectsStore(deps.db),
    clock: deps.clock,
    logger: deps.logger.child({ module: "projects" }),
    newId: deps.newId,
    ...(deps.folders ? { folders: deps.folders } : {}),
  });
```

`apps/daemon/src/daemon.ts` line 33 becomes:

```ts
import { createSessionsModule, resolveSessionCwd, SESSIONS_MIGRATIONS } from "./modules/sessions/index.ts";
```

and line 185 (`const projects = createProjectsModule({ db, clock, logger, newId });`) becomes:

```ts
    // projects.add follows sessions.create's folder rules (decision 85, PH1); no project lives in pap's or Pi's own state.
    const projects = createProjectsModule({
      db,
      clock,
      logger,
      newId,
      folders: {
        resolve: resolveSessionCwd,
        scopeOf: (real) => policy.port.scopeOf(real),
        stateDirs: [config.home, config.piAgentDir],
      },
    });
```

Run: `pnpm exec vitest run --project unit apps/daemon/src/modules/projects/ && pnpm typecheck`
Expected: PASS; typecheck clean (`HandlerTable` now requires the handler, which `...projects.rpc` provides).

- [ ] **Step 11: Write the integration tests over `/ws`**

Replace `apps/daemon/src/daemon.projects.int.test.ts` with:

```ts
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./kernel/db/database.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [] });
});
afterEach(async () => {
  await t.stop();
});

type Added = { project: { id: string; root: string; name: string } };
const ok = <T>(frame: { ok: boolean; result?: unknown }): T => {
  if (!frame.ok) throw new Error(`call failed: ${JSON.stringify(frame)}`);
  return frame.result as T;
};
async function mint(cookie: string, owner: TestClient, permissions: string[]): Promise<TestClient> {
  await t.confirmStepUp(cookie);
  const created = await owner.call("auth.tokens.create", {
    name: "ci",
    permissions: permissions as never,
    expiresInDays: 7,
  });
  return t.connectBearer(ok<{ value: string }>(created).value);
}

describe("projects over /ws", () => {
  it("refuses an unknown project and an empty name", async () => {
    const client = await t.connect(await t.login());
    expect(
      await client.call("projects.update", {
        projectId: "nope",
        change: { kind: "move", before: null },
      } as never),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await client.call("projects.update", {
        projectId: "nope",
        change: { kind: "rename", name: "" },
      } as never),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});

describe("projects.add over /ws (decision 85)", () => {
  it("files a folder under its git root, answers the same project again, and never another owner's", async () => {
    const owner = await t.connect(await t.login());
    const repo = join(t.root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"));
    const db = openDatabase(join(t.home, "state.db"));
    db.run(
      "INSERT INTO projects (id, owner_id, root, name, position, created_at) VALUES ('ghost-p', 'ghost-owner', $root, 'ghost', 0, 0)",
      { root: repo },
    );
    db.close();
    const first = ok<Added>(await owner.call("projects.add", { root: join(repo, "src") }));
    expect(first.project).toMatchObject({ root: repo, name: "repo" });
    expect(first.project.id).not.toBe("ghost-p");
    expect(ok<Added>(await owner.call("projects.add", { root: `${repo}/` })).project.id).toBe(first.project.id);
  });

  it("refuses pap's home, Pi's agent folder and a link into them; a missing folder is invalid_cwd", async () => {
    const owner = await t.connect(await t.login());
    const link = join(t.root, "work", "to-home");
    symlinkSync(t.home, link);
    for (const root of [t.home, join(t.root, "agent"), link])
      expect(await owner.call("projects.add", { root }), root).toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
    expect(await owner.call("projects.add", { root: join(t.root, "missing") })).toMatchObject({
      ok: false,
      error: { code: "invalid_cwd" },
    });
  });

  it("lets a token add a project exactly when it may create a session, and the project is its owner's", async () => {
    const cookie = await t.login();
    const owner = await t.connect(cookie);
    const reader = await mint(cookie, owner, ["sessions:read"]);
    expect(await reader.call("projects.add", { root: t.cwd })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await reader.call("sessions.create", { cwd: t.cwd })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const operator = await mint(cookie, owner, ["sessions:read", "sessions:operate"]);
    const added = ok<Added>(await operator.call("projects.add", { root: t.cwd }));
    expect(await operator.call("sessions.create", { cwd: t.cwd })).toMatchObject({ ok: true });
    expect(ok<Added>(await owner.call("projects.add", { root: t.cwd })).project.id).toBe(added.project.id);
  });
});
```

- [ ] **Step 12: Run the integration tests**

Run: `pnpm exec vitest run --project integration apps/daemon/src/daemon.projects.int.test.ts`
Expected: PASS.

- [ ] **Step 13: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit packages/contracts apps/daemon/src/modules/projects`
Expected: clean.

```bash
git add packages/contracts/src/shell.ts packages/contracts/src/shell.test.ts \
  apps/daemon/src/modules/projects apps/daemon/src/daemon.ts apps/daemon/src/daemon.projects.int.test.ts
git commit -m "feat(projects): add projects.add, a folder's project under sessions.create's rules"
```

---

### Task 2: Projects with no session yet stay in the chip

Track 1. Spec §3.5, §3.6 ("On success, the chip switches"). Ruling PH3.

**Files:**
- Modify: `packages/contracts/src/shell.ts` (`ProjectSummary.unused`, snapshot comment), `shell.test.ts`
- Modify: `apps/daemon/src/modules/projects/service.ts` (`all`), `index.ts` (`ProjectsPort.all`)
- Modify: `apps/daemon/src/modules/sessions/marks-store.ts` (`projectsInUse`, `usesProject`)
- Modify: `apps/daemon/src/modules/sessions/service-shell.ts`
- Modify: `apps/daemon/src/modules/sessions/testing/fake-projects.ts`
- Test: `apps/daemon/src/modules/sessions/service.shell.unused.test.ts` (create)
- Modify: `apps/web/src/stores/current-project.ts`, `current-project.test.ts`
- Modify: `apps/web/src/routes/shell/ProjectSwitcher.tsx`, `ProjectSwitcher.test.tsx`

**Interfaces:**
- Consumes: Task 1's `ProjectView` (contracts) and `ProjectsService`.
- Produces:
  - contracts `ProjectSummary.unused?: true` ("no session of the owner files under it yet").
  - daemon `ProjectsPort.all(ownerId: string): ProjectView[]` (the person's order); `MarksStore.projectsInUse(ownerId: string): Set<string>`; `MarksStore.usesProject(ownerId: string, projectId: string): boolean`.
  - web `listedProjects(projects: ReadonlyMap<string, ProjectSummary>): ProjectSummary[]` in `stores/current-project.ts` (sorted: position, name, id).

- [ ] **Step 1: Failing contract test**

Append to the `describe("shell schemas (M4)", …)` block of `packages/contracts/src/shell.test.ts`:

```ts
  it("marks a project no session files under yet with unused: true, and nothing else", () => {
    expect(ProjectSummary.parse({ ...project, sessions: 0, unused: true })).toEqual({
      ...project,
      sessions: 0,
      unused: true,
    });
    expect(ProjectSummary.safeParse({ ...project, unused: false }).success).toBe(false);
    expect(ProjectSummary.parse(project)).toEqual(project);
  });
```

Run: `pnpm exec vitest run --project unit packages/contracts/src/shell.test.ts`
Expected: FAIL — `unused` is stripped, so the first `toEqual` fails.

- [ ] **Step 2: Add the field**

In `packages/contracts/src/shell.ts`:

```ts
export const ProjectSummary = ProjectView.extend({
  /** Its sessions that are not archived. */
  sessions: z.number().int().nonnegative(),
  /**
   * No session of the owner files under it yet (added by hand, or made by a trigger): the switcher lists it although it
   * has no active session (decision 85, PH3). Absent otherwise.
   */
  unused: z.literal(true).optional(),
});
```

and the snapshot's `projects` comment becomes:

```ts
    /**
     * The projects its sessions name, then every other project of the owner with an active session or with no session at
     * all (`unused`), in the person's order, while there are fewer than `SHELL_LIMITS.projects` (owner Q15, M4R32,
     * decision 85): 550 at most in all.
     */
```

Run: `pnpm exec vitest run --project unit packages/contracts/src/shell.test.ts`
Expected: PASS.

- [ ] **Step 3: Failing daemon tests**

Create `apps/daemon/src/modules/sessions/service.shell.unused.test.ts`:

```ts
import type { EventFrame, Marks, ShellStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const NO_MARKS: Marks = {
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  settledAuto: false,
  unsettledAt: null,
  snoozedUntil: null,
};
const insert = (id: string, cwd: string, ownerId = "u1", marks: Partial<Marks> = {}) => {
  bed.store.insert(
    { id, piPath: null, piSessionId: null, cwd, ownerId, name: null, createdAt: 1, updatedAt: 1 },
    `p:${cwd}`,
  );
  if (Object.keys(marks).length > 0) bed.store.marks.write(id, { ...NO_MARKS, ...marks }, null);
};
const projectsOf = (ownerId: string) => {
  const snapshot = bed.service.shellSnapshot(ownerId);
  if (snapshot.kind !== "snapshot") throw new Error("not a snapshot");
  return snapshot.projects;
};

describe("projects no session files under yet (decision 85, PH3)", () => {
  it("are in the snapshot, flagged unused, beside the active ones; all-archived and other owners' are not", () => {
    bed = build();
    insert("a", "/w/a");
    insert("old", "/w/old", "u1", { archivedAt: 5 });
    for (const root of ["/w/a", "/w/old", "/w/new"]) bed.projects.ensure("u1", root);
    bed.projects.ensure("u2", "/w/theirs");
    expect(projectsOf("u1")).toEqual([
      { id: "p:/w/a", root: "/w/a", name: "a", position: 0, sessions: 1 },
      { id: "p:/w/new", root: "/w/new", name: "new", position: 0, sessions: 0, unused: true },
    ]);
    expect(projectsOf("u2").map((project) => project.id)).toEqual(["p:/w/theirs"]);
  });

  it("drop the flag once a session files under the project", () => {
    bed = build();
    bed.projects.ensure("u1", "/w/new");
    expect(projectsOf("u1")).toEqual([
      { id: "p:/w/new", root: "/w/new", name: "new", position: 0, sessions: 0, unused: true },
    ]);
    insert("s", "/w/new");
    expect(projectsOf("u1")).toEqual([{ id: "p:/w/new", root: "/w/new", name: "new", position: 0, sessions: 1 }]);
  });

  it("go out as a project event flagged unused when the project is made", async () => {
    bed = build();
    bed.hub.registerSnapshot("shell", (key) => bed.service.shellSnapshot(key));
    const frames: EventFrame[] = [];
    bed.hub.open({
      connectionId: "c",
      sub: "s",
      stream: "shell",
      key: "u1",
      after: undefined,
      send: (frame) => void frames.push(frame),
    });
    frames.length = 0;
    bed.projects.ensure("u1", "/w/new");
    await bed.clock.advance(0);
    expect(frames.map((frame) => frame.event as ShellStreamEvent)).toContainEqual({
      kind: "project",
      project: { id: "p:/w/new", root: "/w/new", name: "new", position: 0, sessions: 0, unused: true },
    });
  });
});
```

Run: `pnpm exec vitest run --project unit apps/daemon/src/modules/sessions/service.shell.unused.test.ts`
Expected: FAIL — `/w/new` is missing from the snapshot and the event has no `unused`.

- [ ] **Step 4: Implement the daemon side**

`apps/daemon/src/modules/projects/service.ts`, in the returned object, after `list`:

```ts
    /** Every project of the owner, in the person's order (the shell snapshot's unused ones, decision 85). */
    all: (ownerId: string): ProjectView[] => deps.store.list(ownerId).map(viewOf),
```

`apps/daemon/src/modules/projects/index.ts`: add to `ProjectsPort`

```ts
  /** Every project of the owner, in the person's order: the snapshot lists the ones no session files under (decision 85). */
  all(ownerId: string): ProjectView[];
```

and `all: service.all,` to the `port` object.

`apps/daemon/src/modules/sessions/marks-store.ts`: add to `MarksStore` after `countByProject`

```ts
  /** The projects at least one of the owner's sessions files under, archived ones included. */
  projectsInUse(ownerId: string): Set<string>;
  /** True when at least one of the owner's sessions, archived or not, files under the project. */
  usesProject(ownerId: string, projectId: string): boolean;
```

and to the object `createMarksStore` returns, after `countByProject`:

```ts
    projectsInUse: (ownerId) =>
      new Set(
        db
          .all<{ projectId: string }>(
            "SELECT DISTINCT project_id AS projectId FROM sessions WHERE owner_id = $ownerId AND project_id IS NOT NULL",
            { ownerId },
          )
          .map((row) => row.projectId),
      ),
    usesProject: (ownerId, projectId) =>
      db.get<{ one: number }>(
        "SELECT 1 AS one FROM sessions WHERE owner_id = $ownerId AND project_id = $projectId LIMIT 1",
        { ownerId, projectId },
      ) !== undefined,
```

`apps/daemon/src/modules/sessions/service-shell.ts`: replace `project` and `snapshot`:

```ts
  const project = (ownerId: string, projectId: string): ProjectSummary | null => {
    const view = deps.projects.list(ownerId, [projectId])[0];
    if (!view) return null;
    const summary: ProjectSummary = { ...view, sessions: deps.store.countByProject(ownerId, projectId) };
    return deps.store.usesProject(ownerId, projectId) ? summary : { ...summary, unused: true };
  };
```

```ts
    snapshot(ownerId: string): ShellStreamEvent {
      const rows = deps.store.window(ownerId, SHELL_LIMITS.sessions + SHELL_LIMITS.pins);
      const counts = deps.store.activeByProject(ownerId);
      const inUse = deps.store.projectsInUse(ownerId);
      // Every project with an active session (owner Q15, M4R132), and every one no session files under yet (decision 85).
      const active: ProjectSummary[] = deps.projects
        .list(ownerId, [...counts.keys()])
        .map((view) => ({ ...view, sessions: counts.get(view.id) ?? 0 }));
      const unused: ProjectSummary[] = deps.projects
        .all(ownerId)
        .filter((view) => !inUse.has(view.id))
        .map((view) => ({ ...view, sessions: 0, unused: true }));
      const projects = [...active, ...unused].sort(
        (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      return fitShellSnapshot({
        sessions: rows.map((row) => summaryOf(row, deps.live(row.id))),
        projects,
        active: deps.store.countActive(ownerId),
        archived: deps.store.countArchived(ownerId),
      });
    },
```

`apps/daemon/src/modules/sessions/testing/fake-projects.ts`: add after `roots`:

```ts
    all: (ownerId) =>
      [
        ...new Set(
          ensured
            .filter((call) => call.ownerId === ownerId && !options.refuse?.includes(call.root))
            .map((call) => call.root),
        ),
      ].map(viewOf),
```

Run: `pnpm exec vitest run --project unit apps/daemon/src/modules/sessions/ apps/daemon/src/modules/projects/ && pnpm typecheck`
Expected: PASS (the earlier `service.shell.test.ts` expectations keep passing: active projects carry no `unused` key). If `pnpm typecheck` names another full `ProjectsPort` fake, add `all: () => []` to it.

- [ ] **Step 5: Failing web tests**

Append to `apps/web/src/stores/current-project.test.ts`:

```ts
import { shellProject } from "../testing/shell-snapshot.ts";
import { listedProjects } from "./current-project.ts";

describe("listedProjects (decision 85)", () => {
  it("lists projects with an active session and those no session files under yet, in the person's order", () => {
    const projects = new Map(
      [
        shellProject({ id: "b", name: "b", position: 2, sessions: 1 }),
        shellProject({ id: "idle", name: "idle", position: 0, sessions: 0 }),
        shellProject({ id: "new", name: "new", position: 3, sessions: 0, unused: true }),
        shellProject({ id: "a", name: "a", position: 1, sessions: 2 }),
      ].map((project) => [project.id, project]),
    );
    expect(listedProjects(projects).map((project) => project.id)).toEqual(["a", "b", "new"]);
  });
});
```

(Merge the two imports into the file's existing import lines when it already imports from these modules.)

Append to the `describe("the project switcher", …)` block of `apps/web/src/routes/shell/ProjectSwitcher.test.tsx`:

```ts
  it("lists a project no session files under yet, and still hides an idle one", async () => {
    const page = await renderShell("/");
    await settle();
    await feed([shellSession({ id: "a1", projectId: "api" })], {
      projects: [
        shellProject({ id: "api", name: "api", position: 1, sessions: 1 }),
        shellProject({ id: "idle", name: "idle", position: 2, sessions: 0 }),
        shellProject({ id: "fresh", name: "fresh", position: 3, sessions: 0, unused: true }),
      ],
    });
    await openSwitcher();
    expect(labels()).toEqual(["All projects", "api", "fresh"]);
    await page.unmount();
  });
```

Run: `pnpm exec vitest run --project unit apps/web/src/stores/current-project.test.ts apps/web/src/routes/shell/ProjectSwitcher.test.tsx`
Expected: FAIL — `listedProjects` is not exported; "fresh" is not listed.

- [ ] **Step 6: Implement the web side**

`apps/web/src/stores/current-project.ts`, append:

```ts
const inOrder = (a: ProjectSummary, b: ProjectSummary): number =>
  a.position - b.position || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);

/**
 * The projects the switcher and the home's picker list: those with an active session (owner Q15) and those no session
 * files under yet (decision 85, PH3), in the person's order.
 */
export const listedProjects = (projects: ReadonlyMap<string, ProjectSummary>): ProjectSummary[] =>
  [...projects.values()].filter((project) => project.sessions > 0 || project.unused === true).sort(inOrder);
```

`apps/web/src/routes/shell/ProjectSwitcher.tsx`: delete the local `inOrder`, import `listedProjects` with `useCurrentProject, useEffectiveProject` from `../../stores/current-project.ts`, and build the items as:

```ts
  const items: MenuItem[] = [
    { id: "all", label: t("shell.project.all"), onSelect: () => choose(null) },
    ...listedProjects(projects).map((project) => ({
      id: project.id,
      label: project.name,
      onSelect: () => choose(project.id),
    })),
  ];
```

Drop the now unused `ProjectSummary` type import. Update the component comment: "a menu of every project with an active session, or none yet".

Run: `pnpm exec vitest run --project unit apps/web/src/stores apps/web/src/routes/shell/ProjectSwitcher.test.tsx`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit packages/contracts apps/daemon/src/modules/sessions apps/web/src/stores apps/web/src/routes/shell`
Expected: clean.

```bash
git add packages/contracts/src/shell.ts packages/contracts/src/shell.test.ts apps/daemon/src/modules \
  apps/web/src/stores/current-project.ts apps/web/src/stores/current-project.test.ts \
  apps/web/src/routes/shell/ProjectSwitcher.tsx apps/web/src/routes/shell/ProjectSwitcher.test.tsx
git commit -m "feat(projects): keep a project with no session yet in the shell snapshot and the switcher"
```

---
### Task 3: Add project dialog, its host, the chip's "Add project…"

Track 1. Spec §3.6, §8 (dialog lazy), §9 ("the Add project dialog: check, add, each error code's words"). Ruling PH2.

**Files:**
- Create: `apps/web/src/stores/add-project-request.ts`
- Modify: `apps/web/src/stores/shell-store.ts` (`holdProject`)
- Create: `apps/web/src/stores/shell-store.hold.test.ts`
- Create: `apps/web/src/i18n/catalog/add-project.ts`, `apps/web/src/features/projects/register-add-project-catalog.ts`
- Create: `apps/web/src/features/projects/add-project.vm.ts`, `add-project.vm.test.ts`
- Create: `apps/web/src/features/projects/AddProjectDialog.tsx`, `AddProjectDialog.test.tsx`
- Create: `apps/web/src/routes/shell/AddProjectHost.tsx`
- Modify: `apps/web/src/routes/shell/AppShell.tsx` (mount the host), `ProjectSwitcher.tsx`, `ProjectSwitcher.test.tsx`
- Modify: `apps/web/src/i18n/catalog/shell.ts` (`shell.project.add`), `apps/web/src/i18n/index.ts`, `catalog-keys.test.ts`
- Create: `apps/web/src/i18n/lazy-catalog.add-project.test.ts`
- Modify: `apps/web/src/build-output.int.test.ts`

**Interfaces:**
- Consumes: `ProjectView`, `methods["projects.add"]` (Task 1); `ProjectSummary.unused` (Task 2); `lanes.preview` (existing: `{ repo: boolean, … }`).
- Produces:
  - `useAddProjectRequest` (zustand): `{ open: boolean; onAdded: ((projectId: string) => void) | null; ask(onAdded?: (projectId: string) => void): void; close(): void }`.
  - `holdProject(view: ProjectView): void` in `stores/shell-store.ts`.
  - `AddProjectDialog({ onClose(): void; onAdded(projectId: string): void })`, named export, in its own lazy chunk.
  - `isAbsolutePath(text: string): boolean`, `addProjectFailure(failure: unknown): MessageKey` in `features/projects/add-project.vm.ts`.
  - `AddProjectHost()` in `routes/shell/AddProjectHost.tsx`, mounted once by `AppShell`.
  - Message keys `addProject.*` (lazy), `shell.project.add` (eager).

- [ ] **Step 1: Failing store and view-model tests**

Create `apps/web/src/stores/shell-store.hold.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { holdProject, useShellStore } from "./shell-store.ts";

beforeEach(() => useShellStore.getState().reset());

describe("holdProject (Add project)", () => {
  it("holds a project the stream has not sent yet, as unused", () => {
    holdProject({ id: "p9", root: "/w/new", name: "new", position: -1 });
    expect(useShellStore.getState().view.projects.get("p9")).toEqual({
      id: "p9",
      root: "/w/new",
      name: "new",
      position: -1,
      sessions: 0,
      unused: true,
    });
  });

  it("keeps the stream's counts for a project the store already holds", () => {
    useShellStore.getState().apply({
      kind: "project",
      project: { id: "p1", root: "/w/api", name: "api", position: 1, sessions: 3 },
    });
    holdProject({ id: "p1", root: "/w/api", name: "API", position: 1 });
    expect(useShellStore.getState().view.projects.get("p1")).toEqual({
      id: "p1",
      root: "/w/api",
      name: "API",
      position: 1,
      sessions: 3,
    });
  });
});
```

Create `apps/web/src/features/projects/add-project.vm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { addProjectFailure, isAbsolutePath } from "./add-project.vm.ts";

describe("add project, before and after the call", () => {
  it("knows an absolute path before any call", () => {
    expect(isAbsolutePath(" /w/api ")).toBe(true);
    for (const text of ["", "   ", "w/api", "~/api", "/a\u0000b"]) expect(isAbsolutePath(text), text).toBe(false);
  });

  it("maps each daemon code to its own words, anything else to the shared error words", () => {
    expect(addProjectFailure(new RpcError("invalid_cwd"))).toBe("addProject.error.invalid_cwd");
    expect(addProjectFailure(new RpcError("bad_request"))).toBe("addProject.error.bad_request");
    expect(addProjectFailure(new RpcError("capacity"))).toBe("addProject.error.capacity");
    expect(addProjectFailure(new RpcError("read_only"))).toBe("addProject.error.read_only");
    expect(addProjectFailure(new RpcError("timeout"))).toBe("error.timeout");
    expect(addProjectFailure(new Error("boom"))).toBe("error.internal");
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/stores/shell-store.hold.test.ts apps/web/src/features/projects/add-project.vm.test.ts`
Expected: FAIL — `holdProject` and `add-project.vm.ts` do not exist.

- [ ] **Step 2: Implement the store helpers, the catalog and the view-model**

Append to `apps/web/src/stores/shell-store.ts` (and add `ProjectView` to its `@pap/contracts` type import):

```ts
/**
 * A project an answer named before the stream did (Add project): held at once so the switcher and the home know it, as
 * `unused` until the stream says more. A copy the store already holds keeps the stream's counts.
 */
export function holdProject(view: ProjectView): void {
  const held = useShellStore.getState().view.projects.get(view.id);
  useShellStore.getState().apply({
    kind: "project",
    project: held ? { ...held, ...view } : { ...view, sessions: 0, unused: true },
  });
}
```

Create `apps/web/src/stores/add-project-request.ts`:

```ts
import { create } from "zustand";

interface AddProjectRequestState {
  readonly open: boolean;
  /** What the asker does with the new project once it is added: the home's launch goes on in it (PH13). */
  readonly onAdded: ((projectId: string) => void) | null;
  ask(onAdded?: (projectId: string) => void): void;
  close(): void;
}

/** The chip menu and the home's picker open the Add project dialog through this; the shell's host owns the dialog. */
export const useAddProjectRequest = create<AddProjectRequestState>()((set) => ({
  open: false,
  onAdded: null,
  ask: (onAdded) => set({ open: true, onAdded: onAdded ?? null }),
  close: () => set({ open: false, onAdded: null }),
}));
```

Create `apps/web/src/i18n/catalog/add-project.ts`:

```ts
/** The Add project dialog (decision 85): registered by its own chunk, never in the initial bundle. */
export const addProjectEn = {
  "addProject.title": "Add a project",
  "addProject.description": "A folder pap can start sessions, lanes and triggers in.",
  "addProject.path": "Folder",
  "addProject.pathHint": "The absolute path of an existing folder on the server.",
  "addProject.check": "Check",
  "addProject.checking": "Checking…",
  "addProject.add": "Add",
  "addProject.cancel": "Cancel",
  "addProject.root": "Project folder: {root}",
  "addProject.git": "Git repository: lanes and fan-outs can start here.",
  "addProject.notGit": "Not a git repository: sessions and triggers only.",
  "addProject.gitUnknown": "pap could not tell whether this folder is a git repository.",
  "addProject.notAbsolute": "Write an absolute path, starting with /.",
  "addProject.error.invalid_cwd": "No folder exists at this path, or pap cannot open it.",
  "addProject.error.bad_request": "This folder holds pap's or Pi's own data: it cannot be a project.",
  "addProject.error.capacity": "This account has 2000 projects, the most pap keeps.",
  "addProject.error.read_only": "The database was written by a newer pap and is read-only.",
} as const;

export const addProjectFr: { readonly [K in keyof typeof addProjectEn]: string } = {
  "addProject.title": "Ajouter un dossier de projet",
  "addProject.description": "Un dossier où pap peut lancer des sessions, des lanes et des déclencheurs.",
  "addProject.path": "Dossier",
  "addProject.pathHint": "Le chemin absolu d'un dossier existant sur le serveur.",
  "addProject.check": "Vérifier",
  "addProject.checking": "Vérification…",
  "addProject.add": "Ajouter",
  "addProject.cancel": "Annuler",
  "addProject.root": "Dossier du projet : {root}",
  "addProject.git": "Dépôt git : les lanes et les fan-outs peuvent partir d'ici.",
  "addProject.notGit": "Pas un dépôt git : sessions et déclencheurs seulement.",
  "addProject.gitUnknown": "pap n'a pas pu savoir si ce dossier est un dépôt git.",
  "addProject.notAbsolute": "Écrivez un chemin absolu, qui commence par /.",
  "addProject.error.invalid_cwd": "Aucun dossier n'existe à ce chemin, ou pap ne peut pas l'ouvrir.",
  "addProject.error.bad_request": "Ce dossier contient les données de pap ou de Pi : il ne peut pas être un projet.",
  "addProject.error.capacity": "Ce compte a 2000 projets, le plus que pap garde.",
  "addProject.error.read_only": "La base de données a été écrite par un pap plus récent et est en lecture seule.",
};
```

Create `apps/web/src/features/projects/register-add-project-catalog.ts`:

```ts
import { addProjectEn, addProjectFr } from "../../i18n/catalog/add-project.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the dialog's own chunk, before any of its components renders.
registerCatalog({ en: addProjectEn, fr: addProjectFr });
```

In `apps/web/src/i18n/index.ts`, add `import type { addProjectEn } from "./catalog/add-project.ts";` beside the other lazy type imports and `| keyof typeof addProjectEn` to `MessageKey`.

Create `apps/web/src/features/projects/add-project.vm.ts`:

```ts
import { errorKey, type MessageKey } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

/** The one check made before any call: the daemon resolves the rest (`invalid_cwd`). */
export const isAbsolutePath = (text: string): boolean => text.trim().startsWith("/") && !text.includes("\0");

const WORDS: Readonly<Record<string, MessageKey>> = {
  invalid_cwd: "addProject.error.invalid_cwd",
  bad_request: "addProject.error.bad_request",
  capacity: "addProject.error.capacity",
  read_only: "addProject.error.read_only",
};

/** The daemon's code in the dialog's own words (§3.6); any other code says what it says everywhere. */
export function addProjectFailure(failure: unknown): MessageKey {
  const code = failure instanceof RpcError ? failure.code : "internal";
  return Object.hasOwn(WORDS, code) ? (WORDS[code] as MessageKey) : errorKey(code);
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/stores/shell-store.hold.test.ts apps/web/src/features/projects/add-project.vm.test.ts`
Expected: PASS.

- [ ] **Step 3: Failing dialog tests**

Create `apps/web/src/features/projects/AddProjectDialog.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { alerts, button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AddProjectDialog } from "./AddProjectDialog.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const added = { id: "p9", root: "/w/new", name: "new", position: -3 };
let bed: ReturnType<typeof fakeRuntime>;
const onClose = vi.fn();
const onAdded = vi.fn();
const dialog = () => document.querySelector("[data-add-project]") as HTMLElement;
const open = () => mount(<AddProjectDialog onClose={onClose} onAdded={onAdded} />);
async function check(path: string) {
  await typeInto(field(document.body, "Folder"), path);
  await click(button(document.body, "Check"));
  await settle();
}

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["projects.add"] = () => ({ project: added });
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  useShellStore.getState().reset();
  onClose.mockReset();
  onAdded.mockReset();
});
afterEach(() => setLocale("en"));

describe("Add project (§3.6)", () => {
  it("checks the folder, shows its project folder and that it is a git repository, then adds it", async () => {
    await open();
    expect(button(document.body, "Add").disabled).toBe(true);
    await check("  /w/new/src ");
    expect(bed.called("projects.add")[0]?.params).toEqual({ root: "/w/new/src" });
    expect(bed.called("lanes.preview")[0]?.params).toEqual({ projectRoot: "/w/new" });
    expect(text(dialog())).toContain("Project folder: /w/new");
    expect(text(dialog())).toContain("Git repository: lanes and fan-outs can start here.");
    expect(useShellStore.getState().view.projects.get("p9")).toEqual({ ...added, sessions: 0, unused: true });
    await click(button(document.body, "Add"));
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("p9");
  });

  it("says when the folder is not a git repository, and when pap could not tell", async () => {
    bed.handlers["lanes.preview"] = () => ({ repo: false });
    await open();
    await check("/w/new");
    expect(text(dialog())).toContain("Not a git repository: sessions and triggers only.");
    bed.handlers["lanes.preview"] = () => {
      throw new RpcError("timeout");
    };
    await check("/w/new/");
    expect(text(dialog())).toContain("pap could not tell whether this folder is a git repository.");
  });

  it("refuses a path that is not absolute before any call", async () => {
    await open();
    await check("w/new");
    expect(alerts(document.body)).toContain("Write an absolute path, starting with /.");
    expect(bed.called("projects.add")).toEqual([]);
  });

  it.each([
    ["invalid_cwd", "No folder exists at this path, or pap cannot open it."],
    ["bad_request", "This folder holds pap's or Pi's own data: it cannot be a project."],
    ["capacity", "This account has 2000 projects, the most pap keeps."],
    ["read_only", "The database was written by a newer pap and is read-only."],
    [
      "timeout",
      "The session did not answer in time. The action may still have gone through: check before trying again.",
    ],
  ] as const)("says what %s means, inline, and keeps Add off", async (code, words) => {
    bed.handlers["projects.add"] = () => {
      throw new RpcError(code);
    };
    await open();
    await check("/w/new");
    expect(alerts(document.body)).toContain(words);
    expect(button(document.body, "Add").disabled).toBe(true);
  });

  it("says the daemon's codes in French", async () => {
    setLocale("fr");
    bed.handlers["projects.add"] = () => {
      throw new RpcError("bad_request");
    };
    await open();
    await typeInto(field(document.body, "Dossier"), "/w/new");
    await click(button(document.body, "Vérifier"));
    await settle();
    expect(alerts(document.body)).toContain(
      "Ce dossier contient les données de pap ou de Pi : il ne peut pas être un projet.",
    );
  });

  it("forgets a check once the path changes", async () => {
    await open();
    await check("/w/new");
    await typeInto(field(document.body, "Folder"), "/w/other");
    expect(text(dialog())).not.toContain("Project folder:");
    expect(button(document.body, "Add").disabled).toBe(true);
  });

  it("Cancel closes without adding", async () => {
    await open();
    await click(button(document.body, "Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAdded).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/projects/AddProjectDialog.test.tsx`
Expected: FAIL — `AddProjectDialog.tsx` does not exist.

- [ ] **Step 4: Implement the dialog**

Create `apps/web/src/features/projects/AddProjectDialog.tsx`:

```tsx
import "./register-add-project-catalog.ts";
import type { ProjectView } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { Fragment, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { holdProject } from "../../stores/shell-store.ts";
import { addProjectFailure, isAbsolutePath } from "./add-project.vm.ts";

interface Props {
  onClose(): void;
  /** The project was added: the host switches the chip to it and lets the asker go on. */
  onAdded(projectId: string): void;
}

interface Checked {
  readonly project: ProjectView;
  /** `lanes.preview`'s answer; null when it could not be read. */
  readonly git: boolean | null;
}

/**
 * Add project (decision 85, §3.6): one absolute path, Check, Add. Check calls `projects.add`, which is idempotent, then
 * reads whether the folder is a git repository (PH2); Add switches the chip. Errors are the daemon's codes in words.
 */
export function AddProjectDialog({ onClose, onAdded }: Props) {
  const t = useT();
  const [path, setPath] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  // Promise chains, not try/finally: the React Compiler bails out on a finalizer.
  const check = () => {
    if (busy) return;
    if (!isAbsolutePath(path)) {
      setProblem("addProject.notAbsolute");
      return;
    }
    setBusy(true);
    setProblem(null);
    setChecked(null);
    const { rpc } = getRuntime();
    rpc.call("projects.add", { root: path.trim() }).then(
      ({ project }) => {
        holdProject(project);
        rpc.call("lanes.preview", { projectRoot: project.root }).then(
          (preview) => {
            setBusy(false);
            setChecked({ project, git: preview.repo });
          },
          () => {
            setBusy(false);
            setChecked({ project, git: null });
          },
        );
      },
      (failure: unknown) => {
        setBusy(false);
        setProblem(addProjectFailure(failure));
      },
    );
  };

  const gitLine: MessageKey =
    checked?.git === null ? "addProject.gitUnknown" : checked?.git ? "addProject.git" : "addProject.notGit";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={t("addProject.title")}
      description={t("addProject.description")}
      closeLabel={t("ui.close")}
      footer={
        <Fragment>
          <Button disabled={busy} onClick={onClose}>
            {t("addProject.cancel")}
          </Button>
          <Button disabled={busy || path.trim() === ""} onClick={check}>
            {t(busy ? "addProject.checking" : "addProject.check")}
          </Button>
          <Button
            variant="primary"
            disabled={checked === null || busy}
            onClick={() => {
              if (checked !== null) onAdded(checked.project.id);
            }}
          >
            {t("addProject.add")}
          </Button>
        </Fragment>
      }
    >
      <div data-add-project="" className="flex flex-col gap-s3 p-s3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            check();
          }}
        >
          <TextField
            label={t("addProject.path")}
            hint={t("addProject.pathHint")}
            value={path}
            name="root"
            error={problem === null ? null : t(problem)}
            onChange={(next) => {
              setPath(next);
              setChecked(null);
              setProblem(null);
            }}
          />
        </form>
        {checked !== null ? (
          <div role="status" className="flex flex-col gap-s1">
            <p className="break-all font-mono text-code text-fg">
              {t("addProject.root", { root: checked.project.root })}
            </p>
            <p className="text-ui text-muted">{t(gitLine)}</p>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/projects/AddProjectDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Failing switcher test for the whole path**

In `apps/web/src/routes/shell/ProjectSwitcher.test.tsx`:
- add `button, field, text, typeInto` to the `../../testing/dom.ts` import;
- add `await import("../../features/projects/AddProjectDialog.tsx");` to the `beforeAll`;
- "Add project…" is the menu's last row, so update the existing expectations: `["All projects", "api", "web"]` → `["All projects", "api", "web", "Add project…"]`; Task 2's `["All projects", "api", "fresh"]` → `["All projects", "api", "fresh", "Add project…"]`; `toHaveLength(121)` → `toHaveLength(122)`; `labels().at(-1)` → `labels().at(-2)`; `items().at(-1)` (the "7 more" row) → `items().at(-2)`; `["All projects", "1 more project is not listed"]` → `["All projects", "1 more project is not listed", "Add project…"]`;
- append:

```tsx
  it("Add project… opens the dialog, and Add switches the chip to the new project (§3.6)", async () => {
    bed.handlers["projects.add"] = () => ({ project: { id: "fresh", root: "/w/fresh", name: "fresh", position: -1 } });
    bed.handlers["lanes.preview"] = () => ({ repo: false });
    const page = await renderShell("/");
    await settle();
    await three();
    await openSwitcher();
    await pick("Add project…");
    await vi.waitFor(() => expect(document.querySelector("[data-add-project]")).not.toBeNull(), {
      timeout: 2_000,
    });
    await typeInto(field(document.body, "Folder"), "/w/fresh");
    await click(button(document.body, "Check"));
    await settle();
    expect(text(document.querySelector("[data-add-project]") as HTMLElement)).toContain("Not a git repository");
    await click(button(document.body, "Add"));
    await settle();
    expect(document.querySelector("[data-add-project]")).toBeNull();
    expect(trigger().textContent).toBe("fresh");
    expect(localStorage.getItem("pap.project.v1")).toBe('{"v":1,"projectId":"fresh"}');
    await page.unmount();
  });
```

Run: `pnpm exec vitest run --project unit apps/web/src/routes/shell/ProjectSwitcher.test.tsx`
Expected: FAIL — no "Add project…" row.

- [ ] **Step 6: The host, the chip row, the eager string**

Create `apps/web/src/routes/shell/AddProjectHost.tsx`:

```tsx
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { useCurrentProject } from "../../stores/current-project.ts";

const loadDialog = () =>
  import("../../features/projects/AddProjectDialog.tsx").then((m) => ({ default: m.AddProjectDialog }));

const close = () => useAddProjectRequest.getState().close();

/**
 * Owns the Add project dialog (decision 85): the chip menu and the home's picker ask for it through the request store.
 * Fetched on first open, mounted only while open. On Add the chip switches to the project, then the asker goes on.
 */
export function AddProjectHost() {
  const lazyText = useLazyFailureText();
  const open = useAddProjectRequest((state) => state.open);
  return (
    <LazyPanel
      text={lazyText}
      load={loadDialog}
      open={open}
      props={{
        onClose: close,
        onAdded: (projectId: string) => {
          const { onAdded } = useAddProjectRequest.getState();
          close();
          useCurrentProject.getState().choose(projectId);
          onAdded?.(projectId);
        },
      }}
      onFailed={close}
    />
  );
}
```

`apps/web/src/routes/shell/AppShell.tsx`: `import { AddProjectHost } from "./AddProjectHost.tsx";` and render `<AddProjectHost />` right after `<NewLaneHost />`.

`apps/web/src/routes/shell/ProjectSwitcher.tsx`: import `useAddProjectRequest` from `../../stores/add-project-request.ts` and, after the `moreProjects` row is pushed, add:

```ts
  items.push({ id: "add", label: t("shell.project.add"), onSelect: () => useAddProjectRequest.getState().ask() });
```

`apps/web/src/i18n/catalog/shell.ts`: after `"shell.project.more.other"` add `"shell.project.add": "Add project…",` in `shellEn` and `"shell.project.add": "Ajouter un projet…",` in `shellFr`.

Run: `pnpm exec vitest run --project unit apps/web/src/routes/shell/ProjectSwitcher.test.tsx apps/web/src/routes/shell/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 7: Catalog guards and the lazy marker**

In `apps/web/src/i18n/catalog-keys.test.ts`, import `{ addProjectEn, addProjectFr } from "./catalog/add-project.ts"` and add `addProject: Object.keys(addProjectEn),` to the English list and `addProject: Object.keys(addProjectFr),` to the French list.

Create `apps/web/src/i18n/lazy-catalog.add-project.test.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { addProjectEn, addProjectFr } from "./catalog/add-project.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe("lazy catalog (Add project)", () => {
  it("has the same keys and slots in English and French", () => {
    expect(Object.keys(addProjectFr)).toEqual(Object.keys(addProjectEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(addProjectEn) as Array<keyof typeof addProjectEn>) {
      expect(addProjectFr[key], key).not.toBe("");
      expect(slots(addProjectFr[key]), key).toEqual(slots(addProjectEn[key]));
    }
  });

  it("is named only by the dialog's own files: nothing eager can render a raw key", () => {
    const inChunk = new Set([
      "features/projects/AddProjectDialog.tsx",
      "features/projects/add-project.vm.ts",
      "features/projects/register-add-project-catalog.ts",
    ]);
    expect([...inChunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inChunk.has(name)) continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]addProject\./.test(code)) offenders.push(`${name}: addProject key`);
      if (/catalog\/add-project\.ts"|register-add-project-catalog\.ts"/.test(code)) offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });
});
```

In `apps/web/src/build-output.int.test.ts`, after the "new lane dialog" test, add:

```ts
  it("keeps the Add project dialog and its strings out of the initial assets (decision 85)", () =>
    keepsLazyOnly([/data-add-project/, /Project folder: /, /Dossier du projet : /]));
```

Run: `pnpm exec vitest run --project unit apps/web/src/i18n && pnpm exec vitest run --project integration apps/web/src/build-output.int.test.ts`
Expected: PASS.

- [ ] **Step 8: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm knip && pnpm exec vitest run --project unit apps/web/src/features/projects apps/web/src/routes/shell apps/web/src/stores apps/web/src/i18n`
Expected: clean.

```bash
git add apps/web/src/stores apps/web/src/features/projects apps/web/src/routes/shell apps/web/src/i18n \
  apps/web/src/build-output.int.test.ts
git commit -m "feat(web): add project from the chip menu, a lazy dialog that checks the folder first"
```

---

### Task 4: Settings › Appearance › Home

Track 1. Spec §6, §9 ("the Settings › Home checkboxes hiding each part" — the hiding itself is Task 11).

**Files:**
- Modify: `packages/contracts/src/settings.ts`, `settings.test.ts`
- Modify: `apps/web/src/features/appearance/model.ts`, `model.test.ts`
- Create: `apps/web/src/features/appearance/HomeSection.tsx`, `HomeSection.test.tsx`
- Modify: `apps/web/src/features/appearance/AppearancePanel.tsx`
- Modify: `apps/web/src/i18n/catalog/settings-appearance.ts`

**Interfaces:**
- Consumes: the appearance document (`useAppearanceStore`, `parseAccount`, `AppearanceSection`).
- Produces: contracts `HOME_PARTS = ["status", "explore", "automate", "project", "help", "recent"] as const`, `type HomePart`, `HomeLayout` (zod, each boolean defaulting to true), `type HomeLayout`, `DEFAULT_HOME_LAYOUT: HomeLayout`, `AccountAppearance.home: HomeLayout`; web `HomeSection()`.

- [ ] **Step 1: Failing contract and model tests**

In `packages/contracts/src/settings.test.ts`, add `home: { status: true, explore: true, automate: true, project: true, help: true, recent: true },` to the `base` object, add `DEFAULT_HOME_LAYOUT` to the `./settings.ts` import, and append:

```ts
describe("the home layout (decision 85)", () => {
  it("shows every part by default, fills a partial layout with the defaults, and refuses a non-boolean", () => {
    const withoutHome = Object.fromEntries(Object.entries(base).filter(([name]) => name !== "home"));
    expect(AccountAppearance.parse(withoutHome).home).toEqual(DEFAULT_HOME_LAYOUT);
    expect(AccountAppearance.parse({ ...base, home: { status: false } }).home).toEqual({
      ...DEFAULT_HOME_LAYOUT,
      status: false,
    });
    expect(AccountAppearance.safeParse({ ...base, home: { status: "no" } }).success).toBe(false);
  });
});
```

In `apps/web/src/features/appearance/model.test.ts`, append:

```ts
describe("parseAccount: the home layout (decision 85)", () => {
  it("reads it on its own: missing or junk shows everything, and an older document keeps its custom themes", () => {
    const ocean = {
      id: "ocean",
      name: "Ocean",
      base: "night",
      roles: {
        bg: "#0E1626",
        surface: "#132033",
        text: "#E6EDF7",
        agent: "#38BDF8",
        you: "#FB923C",
        attn: "#EC4899",
        ok: "#34D399",
        err: "#F87171",
      },
    } as const;
    const older = { ...DEFAULT_ACCOUNT, customThemes: [ocean], darkTheme: "ocean", home: undefined };
    expect(parseAccount(older).home).toEqual(DEFAULT_ACCOUNT.home);
    expect(parseAccount(older).customThemes).toEqual([ocean]);
    expect(parseAccount(older).darkTheme).toBe("ocean");
    expect(parseAccount({ ...DEFAULT_ACCOUNT, home: "all" }).home).toEqual(DEFAULT_ACCOUNT.home);
    expect(parseAccount({ ...DEFAULT_ACCOUNT, home: { recent: false } }).home).toEqual({
      ...DEFAULT_ACCOUNT.home,
      recent: false,
    });
  });
});
```

(`DEFAULT_ACCOUNT` and `parseAccount` come from `./model.ts`; add them to the file's import if it lacks them.)

Run: `pnpm exec vitest run --project unit packages/contracts/src/settings.test.ts apps/web/src/features/appearance/model.test.ts`
Expected: FAIL — `DEFAULT_HOME_LAYOUT` is not exported; `home` is undefined.

- [ ] **Step 2: Add the field**

In `packages/contracts/src/settings.ts`, before `AccountAppearanceFields`:

```ts
/** The parts of the project home Settings › Appearance › Home can hide (decision 85); the composer is always shown. */
export const HOME_PARTS = ["status", "explore", "automate", "project", "help", "recent"] as const;
export type HomePart = (typeof HOME_PARTS)[number];

export const HomeLayout = z.object({
  status: z.boolean().default(true),
  explore: z.boolean().default(true),
  automate: z.boolean().default(true),
  project: z.boolean().default(true),
  help: z.boolean().default(true),
  recent: z.boolean().default(true),
});
export type HomeLayout = z.infer<typeof HomeLayout>;

export const DEFAULT_HOME_LAYOUT: HomeLayout = {
  status: true,
  explore: true,
  automate: true,
  project: true,
  help: true,
  recent: true,
};
```

and, as the last field of `AccountAppearanceFields`:

```ts
  /** Which parts of the project home show (decision 85). */
  home: HomeLayout.default(DEFAULT_HOME_LAYOUT),
```

In `apps/web/src/features/appearance/model.ts`: import `DEFAULT_HOME_LAYOUT` from `@pap/contracts`; add `home: DEFAULT_HOME_LAYOUT,` to `DEFAULT_ACCOUNT`; add `home: field("home"),` to the object `parseAccount` returns.

Run: `pnpm exec vitest run --project unit packages/contracts/src/settings.test.ts apps/web/src/features/appearance`
Expected: PASS. If another settings test compares a parsed document with a literal, add the `home` default to that literal.

- [ ] **Step 3: Failing section test**

Create `apps/web/src/features/appearance/HomeSection.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { click, mount, text } from "../../testing/dom.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { HomeSection } from "./HomeSection.tsx";
import { DEFAULT_ACCOUNT } from "./model.ts";

registerCatalog({ en: settingsAppearanceEn, fr: settingsAppearanceFr });
const box = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
    (candidate) => candidate.closest("label")?.textContent === label,
  ) as HTMLElement;

beforeEach(() => useAppearanceStore.setState({ account: DEFAULT_ACCOUNT }));

describe("Settings › Appearance › Home (§6)", () => {
  it("has one checkbox per part, all checked by default, and none for the composer", async () => {
    const page = await mount(<HomeSection />);
    expect(text(page.container)).toContain("Home");
    expect(
      [...document.querySelectorAll('[role="checkbox"]')].map((node) => node.getAttribute("aria-checked")),
    ).toEqual(["true", "true", "true", "true", "true", "true"]);
    expect(text(page.container)).toContain("The composer is always shown.");
  });

  it("unchecking a part writes it to the account document and leaves the others", async () => {
    await mount(<HomeSection />);
    await click(box("Status line"));
    await click(box("Recent work"));
    expect(useAppearanceStore.getState().account.home).toEqual({
      ...DEFAULT_ACCOUNT.home,
      status: false,
      recent: false,
    });
    expect(useAppearanceStore.getState().account.customThemes).toEqual(DEFAULT_ACCOUNT.customThemes);
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/appearance/HomeSection.test.tsx`
Expected: FAIL — `HomeSection.tsx` does not exist.

- [ ] **Step 4: Implement the section and its strings**

Append to `settingsAppearanceEn` in `apps/web/src/i18n/catalog/settings-appearance.ts`:

```ts
  "settings.appearance.section.home": "Home",
  "settings.appearance.home.intro": "What the project home shows under its composer. The composer is always shown.",
  "settings.appearance.home.status": "Status line",
  "settings.appearance.home.explore": "Explore: Files, Terminal, Search",
  "settings.appearance.home.automate": "Automate: Tasks, Inbox",
  "settings.appearance.home.project": "Project: Archived lanes, Project settings",
  "settings.appearance.home.help": "Help: Keyboard shortcuts",
  "settings.appearance.home.recent": "Recent work",
```

and to `settingsAppearanceFr`:

```ts
  "settings.appearance.section.home": "Accueil",
  "settings.appearance.home.intro":
    "Ce que l'accueil du projet montre sous sa zone de saisie. La zone de saisie est toujours affichée.",
  "settings.appearance.home.status": "Ligne d'état",
  "settings.appearance.home.explore": "Explorer : Fichiers, Terminal, Rechercher",
  "settings.appearance.home.automate": "Automatiser : Tâches, Boîte",
  "settings.appearance.home.project": "Projet : Lanes archivées, Réglages du projet",
  "settings.appearance.home.help": "Aide : Raccourcis clavier",
  "settings.appearance.home.recent": "Travail récent",
```

Create `apps/web/src/features/appearance/HomeSection.tsx`:

```tsx
import { HOME_PARTS } from "@pap/contracts";
import { Checkbox } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { useAppearanceStore } from "./appearance-store.ts";

/** Settings › Appearance › Home (decision 85, §6): which parts of the project home show; same document, same sync. */
export function HomeSection() {
  const t = useT();
  const account = useAppearanceStore((state) => state.account);
  const setAccount = useAppearanceStore((state) => state.setAccount);
  return (
    <AppearanceSection title={t("settings.appearance.section.home")} scope={t("settings.appearance.scopeAccount")}>
      <p className="text-ui text-muted">{t("settings.appearance.home.intro")}</p>
      {HOME_PARTS.map((part) => (
        <Checkbox
          key={part}
          label={t(`settings.appearance.home.${part}`)}
          checked={account.home[part]}
          onChange={(shown) => setAccount({ ...account, home: { ...account.home, [part]: shown } })}
        />
      ))}
    </AppearanceSection>
  );
}
```

In `apps/web/src/features/appearance/AppearancePanel.tsx`, import `HomeSection` and render `<HomeSection />` after `<DetailsSection />`.

Run: `pnpm exec vitest run --project unit apps/web/src/features/appearance apps/web/src/i18n`
Expected: PASS (the eager/lazy parity test of `i18n.test.tsx` covers `settingsAppearance`; every French string differs from its English one).

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit packages/contracts apps/web/src/features/appearance apps/daemon/src/modules/settings`
Expected: clean.

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts \
  apps/web/src/features/appearance apps/web/src/i18n/catalog/settings-appearance.ts
git commit -m "feat(appearance): Settings › Appearance › Home shows or hides each part of the project home"
```

---
### Task 5: Launch hand-offs (text split, lane title, trigger prefill)

Track 2. Spec §3.1 (Lane, Fan-out, Trigger rows), §9 ("each mode's Launch, with the text split into title and description and the clip limits"). Rulings PH7, PH14. Review Focus 2.

**Files:**
- Create: `apps/web/src/features/home/launch-text.ts`, `launch-text.test.ts`
- Create: `apps/web/src/stores/trigger-prefill.ts`, `trigger-prefill.test.ts`
- Modify: `apps/web/src/stores/new-lane-request.ts` (`title?`)
- Modify: `apps/web/src/features/lanes/new-lane.vm.ts` (`prefillDraft` third parameter), `new-lane.vm.test.ts`
- Modify: `apps/web/src/features/lanes/NewLaneDialog.tsx:40,73`, `new-lane-bed.tsx:69`, `NewLaneDialog.more.test.tsx`
- Modify: `apps/web/src/features/automation/TriggerEditor.tsx`; create `TriggerEditor.prefill.test.tsx`
- Modify: `apps/web/src/routes/shell/trigger-pane-entry.tsx`, `pane-renderers.tsx` (`TriggerPane`)
- Create: `apps/web/src/routes/shell/trigger-prefill.test.tsx`
- Modify: `apps/web/src/routes/shell/AppShell.tsx` (sign-out reset), `AppShell.signout.test.tsx`

**Interfaces:**
- Consumes: contracts `INVISIBLE`, `LANE_LIMITS.title` (200), `AUTOMATION_LIMITS.nameChars` (80), `LaneTitle`, `TriggerName`; `NewLanePrefill` (existing store).
- Produces:
  - `NewLanePrefill` gains `readonly title?: string` (`stores/new-lane-request.ts`).
  - `interface TriggerPrefill { readonly name: string; readonly prompt: string }` and `useTriggerPrefill` (zustand): `{ items: Readonly<Record<string, TriggerPrefill>>; put(projectId: string, prefill: TriggerPrefill): void; peek(projectId: string): TriggerPrefill | null; drop(projectId: string): void }` (`stores/trigger-prefill.ts`).
  - `splitLaunchText(text: string): { readonly first: string; readonly rest: string }`, `clipTitle(title: string, points: number, units: number): string`, `laneLaunch(text: string, projectRoot: string, fanout: boolean): NewLanePrefill`, `triggerLaunch(text: string): TriggerPrefill` (`features/home/launch-text.ts`).
  - `prefillDraft(text, models, title?: string): Draft`; `NewLaneDialog` prop `prefill?: { text; models; title? } | null`; `TriggerEditorProps.prefill?: TriggerPrefill | null`; `TriggerPaneProps.prefill?: TriggerPrefill | null`.

- [ ] **Step 1: Failing text tests (Review Focus 2)**

Create `apps/web/src/features/home/launch-text.test.ts`:

```ts
import { AUTOMATION_LIMITS, LANE_LIMITS, LaneTitle, TriggerName } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { clipTitle, laneLaunch, splitLaunchText, triggerLaunch } from "./launch-text.ts";

describe("splitLaunchText", () => {
  it("takes the first line that shows something, cleaned, and the trimmed lines after it", () => {
    expect(splitLaunchText("Fix the login\nSteps:\n1. open")).toEqual({
      first: "Fix the login",
      rest: "Steps:\n1. open",
    });
    expect(splitLaunchText("\n \n  Fix the login  \r\nwhy\r\n")).toEqual({ first: "Fix the login", rest: "why" });
    expect(splitLaunchText("\u200b\u202e\nReal title\nbody")).toEqual({ first: "Real title", rest: "body" });
    expect(splitLaunchText("Fix\u202e the\u200b login\tnow")).toEqual({ first: "Fix the login now", rest: "" });
    expect(splitLaunchText("   \n\t")).toEqual({ first: "", rest: "" });
  });
});

describe("clipTitle", () => {
  it("keeps to both bounds and never cuts a surrogate pair", () => {
    expect(clipTitle("😀".repeat(150), 200, 200)).toBe("😀".repeat(100));
    expect(clipTitle("😀".repeat(100), 80, 320)).toBe("😀".repeat(80));
    expect(clipTitle("ab😀", 10, 3)).toBe("ab");
    expect(clipTitle("abc def", 4, 10)).toBe("abc");
  });
});

describe("laneLaunch (§3.1 Lane and Fan-out)", () => {
  it("makes the first line the title and the lines after it the description", () => {
    expect(laneLaunch("Replace the cache\nKeep the API", "/w/api", false)).toEqual({
      projectRoot: "/w/api",
      title: "Replace the cache",
      text: "Keep the API",
      models: [null],
    });
  });

  it("keeps the whole text as the description when there is one line: a lane needs one", () => {
    expect(laneLaunch("  Replace the cache  ", "/w/api", false)).toMatchObject({
      title: "Replace the cache",
      text: "Replace the cache",
    });
  });

  it("presets two model slots for a fan-out, an empty one too", () => {
    expect(laneLaunch("", "/w/api", true)).toEqual({ projectRoot: "/w/api", title: "", text: "", models: [null, null] });
  });

  it("hands the dialog a title its schema accepts, whatever the first line holds (Review Focus 2)", () => {
    for (const text of ["😀".repeat(150), `${"x".repeat(500)}\nbody`, "\u202e\u200bFix\u0007 it\nbody", "\r\n\r\nFix\r\nbody"]) {
      const { title } = laneLaunch(text, "/w", false);
      expect(LaneTitle.safeParse(title).success, JSON.stringify(text)).toBe(true);
      expect([...title].length).toBeLessThanOrEqual(LANE_LIMITS.title);
    }
  });
});

describe("triggerLaunch (§3.1 Trigger)", () => {
  it("names the trigger after the first line and keeps the whole text as the prompt", () => {
    expect(triggerLaunch("Nightly report\nSummarise the failures")).toEqual({
      name: "Nightly report",
      prompt: "Nightly report\nSummarise the failures",
    });
    expect(triggerLaunch("  ")).toEqual({ name: "", prompt: "" });
  });

  it("hands the editor a name its schema accepts (Review Focus 2)", () => {
    for (const text of ["😀".repeat(100), "\u202eName\u200b\nx", "y".repeat(500)]) {
      const { name } = triggerLaunch(text);
      expect(TriggerName.safeParse(name).success, JSON.stringify(text)).toBe(true);
      expect([...name].length).toBeLessThanOrEqual(AUTOMATION_LIMITS.nameChars);
    }
  });
});
```

Create `apps/web/src/stores/trigger-prefill.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useTriggerPrefill } from "./trigger-prefill.ts";

beforeEach(() => useTriggerPrefill.setState({ items: {} }));

describe("the trigger prefill (decision 85)", () => {
  it("waits for its project's editor, is read without being consumed, and goes when dropped", () => {
    useTriggerPrefill.getState().put("p1", { name: "Nightly", prompt: "Report" });
    expect(useTriggerPrefill.getState().peek("p2")).toBeNull();
    expect(useTriggerPrefill.getState().peek("p1")).toEqual({ name: "Nightly", prompt: "Report" });
    expect(useTriggerPrefill.getState().peek("p1")).toEqual({ name: "Nightly", prompt: "Report" });
    useTriggerPrefill.getState().drop("p1");
    expect(useTriggerPrefill.getState().peek("p1")).toBeNull();
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/launch-text.test.ts apps/web/src/stores/trigger-prefill.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 2: Implement the store and the text functions**

Create `apps/web/src/stores/trigger-prefill.ts`:

```ts
import { create } from "zustand";

/** What the home's Trigger launch hands a new trigger's editor (§3.1): the name and the prompt. */
export interface TriggerPrefill {
  readonly name: string;
  readonly prompt: string;
}

interface TriggerPrefillState {
  /** By project id: the editor of `new:<project id>` reads its own. */
  readonly items: Readonly<Record<string, TriggerPrefill>>;
  put(projectId: string, prefill: TriggerPrefill): void;
  /** The waiting prefill, left in place: pure, so a state initializer may call it (StrictMode calls those twice). */
  peek(projectId: string): TriggerPrefill | null;
  /** Forgets it once the editor holds it. */
  drop(projectId: string): void;
}

/** The home cannot reach the trigger editor (features never import each other): the shell wires both to this. */
export const useTriggerPrefill = create<TriggerPrefillState>()((set, get) => ({
  items: {},
  put: (projectId, prefill) => set({ items: { ...get().items, [projectId]: prefill } }),
  peek: (projectId) => (Object.hasOwn(get().items, projectId) ? (get().items[projectId] ?? null) : null),
  drop: (projectId) =>
    set({ items: Object.fromEntries(Object.entries(get().items).filter(([id]) => id !== projectId)) }),
}));
```

In `apps/web/src/stores/new-lane-request.ts`, extend the interface:

```ts
/** What "Run again" and the home's launch hand the new lane dialog: the project, the prompt (or issue link), one model per lane. */
export interface NewLanePrefill {
  readonly projectRoot: string;
  readonly text: string;
  readonly models: ReadonlyArray<ModelPick | null>;
  /** The home's title (the launch text's first line, PH7); absent: the dialog suggests one from the text. */
  readonly title?: string;
}
```

Create `apps/web/src/features/home/launch-text.ts`:

```ts
import { AUTOMATION_LIMITS, INVISIBLE, LANE_LIMITS } from "@pap/contracts";
import type { NewLanePrefill } from "../../stores/new-lane-request.ts";
import type { TriggerPrefill } from "../../stores/trigger-prefill.ts";

const HIDDEN = new RegExp(INVISIBLE.source, "gu");

/** A line as a title: a tab is a space, every other hidden character (bidi, zero-width, controls) goes, ends trimmed. */
const visible = (line: string): string => line.replace(HIDDEN, (char) => (char === "\t" ? " " : "")).trim();

/** The first line that shows something, cleaned, and the lines after it, trimmed; both empty for a blank text. */
export function splitLaunchText(text: string): { readonly first: string; readonly rest: string } {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => visible(line) !== "");
  if (at === -1) return { first: "", rest: "" };
  return { first: visible(lines[at] ?? ""), rest: lines.slice(at + 1).join("\n").trim() };
}

/** At most `points` code points and `units` UTF-16 units, never half of a surrogate pair, no trailing space. */
export function clipTitle(title: string, points: number, units: number): string {
  let clipped = "";
  let count = 0;
  for (const char of title) {
    if (count === points || clipped.length + char.length > units) break;
    clipped += char;
    count += 1;
  }
  return clipped.trimEnd();
}

/**
 * Lane and Fan-out (§3.1, PH7): the title is the first line; the description is the lines after it, or the whole text
 * when there are none (a lane needs a description; its first prompt is `# title` then the description).
 */
export function laneLaunch(text: string, projectRoot: string, fanout: boolean): NewLanePrefill {
  const { first, rest } = splitLaunchText(text);
  return {
    projectRoot,
    title: clipTitle(first, LANE_LIMITS.title, LANE_LIMITS.title),
    text: rest === "" ? text.trim() : rest,
    models: fanout ? [null, null] : [null],
  };
}

/** Trigger (§3.1): the name is the first line, clipped; the prompt is the whole text. */
export function triggerLaunch(text: string): TriggerPrefill {
  return {
    name: clipTitle(splitLaunchText(text).first, AUTOMATION_LIMITS.nameChars, AUTOMATION_LIMITS.nameChars * 4),
    prompt: text.trim(),
  };
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/launch-text.test.ts apps/web/src/stores/trigger-prefill.test.ts`
Expected: PASS.

- [ ] **Step 3: Failing lane hand-off tests**

Append inside the last `describe` of `apps/web/src/features/lanes/new-lane.vm.test.ts`:

```ts
  it("takes the home's title as edited, so the description no longer suggests one", () => {
    const draft = prefillDraft("Keep the API", [null, null], "Replace the cache");
    expect(draft).toMatchObject({ text: "Keep the API", title: "Replace the cache", titleEdited: true, branch: "" });
    expect(draft.slots).toHaveLength(2);
    expect(canCreate(draft)).toBe(true);
    expect(prefillDraft("Keep", [null], "   ")).toMatchObject({ title: "Keep", titleEdited: false });
  });
```

In `apps/web/src/features/lanes/new-lane-bed.tsx`, give `open` a third parameter and pass it on:

```tsx
export async function open(
  view: LanePreview = preview(),
  projects: ProjectSummary[] = [project],
  prefill: ComponentProps<typeof NewLaneDialog>["prefill"] = null,
) {
```

with `prefill={prefill}` on `<NewLaneDialog …/>` (import `type ComponentProps` from `react`).

Append to `apps/web/src/features/lanes/NewLaneDialog.more.test.tsx` (add `field` to its `../../testing/dom.ts` import):

```tsx
describe("new lane dialog: the home's prefill (decision 85)", () => {
  it("opens with the home's title, its description and a model row per preset slot", async () => {
    await open(preview(), undefined, { text: "Keep the API", title: "Replace the cache", models: [null, null] });
    expect(field(document.body, "Title").value).toBe("Replace the cache");
    expect(field(document.body, "Issue or description").value).toBe("Keep the API");
    expect(select("Model of lane 2")).toBeDefined();
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/lanes/new-lane.vm.test.ts apps/web/src/features/lanes/NewLaneDialog.more.test.tsx`
Expected: FAIL — the title is derived from the text ("Keep the API").

- [ ] **Step 4: Take the title**

`apps/web/src/features/lanes/new-lane.vm.ts`, replace `prefillDraft`:

```ts
/**
 * The draft "Run again" and the home open with: the text, a slot per model, and the home's title when it gives one
 * (kept as edited, PH7). The branch is left to the daemon.
 */
export function prefillDraft(text: string, models: ReadonlyArray<ModelPick | null>, title?: string): Draft {
  const slots = models.slice(0, LANE_LIMITS.fanout).map((model, key) => ({ key, model }));
  const draft = withText(emptyDraft(), text, "");
  const given = title?.trim() ?? "";
  const titled = given === "" ? draft : { ...draft, title: clip(given), titleEdited: true };
  return { ...titled, branch: "", slots: slots.length === 0 ? draft.slots : slots };
}
```

`apps/web/src/features/lanes/NewLaneDialog.tsx`: the `prefill` prop type becomes

```ts
  readonly prefill?: {
    readonly text: string;
    readonly models: ReadonlyArray<ModelPick | null>;
    readonly title?: string;
  } | null;
```

(comment: `"Run again" and the home: the prompt or issue link, the models, and the home's title.`) and line 73 becomes `prefill ? prefillDraft(prefill.text, prefill.models, prefill.title) : emptyDraft(),`. `NewLaneHost` already passes the request's prefill through unchanged.

Run: `pnpm exec vitest run --project unit apps/web/src/features/lanes`
Expected: PASS.

- [ ] **Step 5: Failing trigger hand-off tests**

Create `apps/web/src/features/automation/TriggerEditor.prefill.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SHELL } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { field } from "../../testing/dom.ts";
import { current, newBed, projectOf, showWithStepUp } from "./board-bed.tsx";
import { knowProject } from "./editor-bed.tsx";
import { TriggerEditor } from "./TriggerEditor.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

// A new trigger mounts the schedule form, whose time-zone select renders about 420 options (0.4 to 0.6 s unloaded).
const NEW_FORM_MS = 20_000;

beforeEach(() => {
  useTasksStore.getState().reset();
  useShellStore.setState({ view: EMPTY_SHELL });
});

describe("TriggerEditor: the home's prefill (decision 85)", () => {
  it("starts a new trigger with the name and prompt it was handed", { timeout: NEW_FORM_MS }, async () => {
    newBed();
    knowProject(projectOf("p1", "atlas"));
    const page = await showWithStepUp(
      <TriggerEditor
        triggerId="new:p1"
        prefill={{ name: "Nightly report", prompt: "Nightly report\nSummarise the failures" }}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
      />,
    );
    expect((field(page.container, "Name") as HTMLInputElement).value).toBe("Nightly report");
    expect((field(page.container, "Prompt") as HTMLTextAreaElement).value).toBe(
      "Nightly report\nSummarise the failures",
    );
    expect((field(page.container, "Folder") as HTMLInputElement).value).toBe("/work/atlas");
  });
});
```

Create `apps/web/src/routes/shell/trigger-prefill.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, pathOfItem, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { field, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore
    .getState()
    .apply(shellSnapshot([], { projects: [shellProject({ id: "p1", name: "atlas", root: "/work/atlas", sessions: 1 })] }));
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  useTriggerPrefill.setState({ items: {} });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

describe("a new trigger's pane (decision 85)", () => {
  it("opens the editor with the name and prompt the home left, then forgets them", { timeout: 20_000 }, async () => {
    useTriggerPrefill.getState().put("p1", { name: "Nightly report", prompt: "Summarise the failures" });
    const page = await renderShell(pathOfItem({ kind: "trigger", id: "new:p1" }));
    await vi.waitFor(() => expect(document.querySelector("[data-trigger-pane]")).not.toBeNull(), {
      timeout: 10_000,
    });
    await settle();
    expect((field(page.container, "Name") as HTMLInputElement).value).toBe("Nightly report");
    expect((field(page.container, "Prompt") as HTMLTextAreaElement).value).toBe("Summarise the failures");
    expect(useTriggerPrefill.getState().items).toEqual({});
    await page.unmount();
  });
});
```

In `apps/web/src/routes/shell/AppShell.signout.test.tsx`, import `useTriggerPrefill` from `../../stores/trigger-prefill.ts`; next to `useComposerPrefill.getState().push("s1", "Review comments");` add `useTriggerPrefill.getState().put("p1", { name: "n", prompt: "p" });`, and after the unmount `expect(useTriggerPrefill.getState().items).toEqual({});`.

Run: `pnpm exec vitest run --project unit apps/web/src/features/automation/TriggerEditor.prefill.test.tsx apps/web/src/routes/shell/trigger-prefill.test.tsx apps/web/src/routes/shell/AppShell.signout.test.tsx`
Expected: FAIL — the editor starts empty; the store is not reset at sign-out.

- [ ] **Step 6: Pass the prefill through**

`apps/web/src/features/automation/TriggerEditor.tsx`: import `type TriggerPrefill` from `../../stores/trigger-prefill.ts`; add to `TriggerEditorProps`

```ts
  /** The home's Trigger launch (§3.1): the new trigger's name and prompt. Read once, when the editor mounts. */
  readonly prefill?: TriggerPrefill | null;
```

take `prefill` in the `TriggerEditor` parameters, and give the new form

```tsx
          draft={{
            ...emptyDraft(project?.root ?? "", browserZone()),
            ...(prefill ? { name: prefill.name, prompt: prefill.prompt } : {}),
          }}
```

`apps/web/src/routes/shell/trigger-pane-entry.tsx`: import `type TriggerPrefill` from `../../stores/trigger-prefill.ts` and add `readonly prefill?: TriggerPrefill | null;` to `TriggerPaneProps`.

`apps/web/src/routes/shell/pane-renderers.tsx`: import `useEffect, useState` from `react` (beside `lazy, Suspense`) and `useTriggerPrefill` from `../../stores/trigger-prefill.ts`; `TriggerPane` becomes:

```tsx
function TriggerPane({ triggerId }: { readonly triggerId: string }) {
  useTasksFeed(true);
  // The home's Trigger launch leaves a name and a prompt for a new trigger: read once (peek is pure, StrictMode calls an
  // initializer twice), then dropped.
  const projectId = triggerId.startsWith("new:") ? triggerId.slice("new:".length) : null;
  const [prefill] = useState(() => (projectId === null ? null : useTriggerPrefill.getState().peek(projectId)));
  useEffect(() => {
    if (projectId !== null) useTriggerPrefill.getState().drop(projectId);
  }, [projectId]);
  const props: TriggerPaneProps = {
    triggerId,
    prefill,
    onOpenSession: openSession,
    onOpenTasks: openTasks,
    onCreated: (id) => openTriggerInstead(triggerId, id),
  };
  return <LazyPane load={loadTrigger} props={props} />;
}
```

`apps/web/src/routes/shell/AppShell.tsx`: import `useTriggerPrefill` and add `useTriggerPrefill.setState({ items: {} });` beside `useComposerPrefill.setState({ items: {} });` in the shell effect's cleanup.

Run: `pnpm exec vitest run --project unit apps/web/src/features/automation apps/web/src/routes/shell/trigger-prefill.test.tsx apps/web/src/routes/shell/AppShell.signout.test.tsx apps/web/src/routes/shell/pane-renderers.test.tsx`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm knip`
Expected: clean. (`launch-text.ts` is imported only by its test until Task 10; knip runs in default mode here, where test files are entries, so its exports count as used.)

```bash
git add apps/web/src/features/home apps/web/src/stores apps/web/src/features/lanes \
  apps/web/src/features/automation apps/web/src/routes/shell
git commit -m "feat(web): hand a launch text to the new lane dialog and a new trigger's editor"
```

---
### Task 6: ⌘K in transcript-search mode, scoped to a project

Track 2. Spec §3.2 ("Search opens ⌘K in transcript-search mode with the project's scope"), §5 (transcript search). Ruling PH8.

**Files:**
- Create: `apps/web/src/stores/palette-request.ts`, `palette-request.test.ts`
- Modify: `apps/web/src/features/commands/palette/CommandPalette.tsx`
- Create: `apps/web/src/features/commands/palette/CommandPalette.search.test.tsx`
- Modify: `apps/web/src/routes/shell/PaletteHost.tsx`
- Create: `apps/web/src/routes/shell/palette-search.test.tsx`
- Modify: `apps/web/src/i18n/catalog/sidebar.ts` (`search.mode.*`)

**Interfaces:**
- Consumes: `useTranscriptSearch(query)` (existing, 3 code points, 150 ms debounce), `SearchHit.session.projectId`.
- Produces:
  - `interface PaletteSearch { readonly projectId: string | null }`; `usePaletteRequest` (zustand): `{ search: PaletteSearch | null; askSearch(projectId: string | null): void; take(): PaletteSearch | null }` (`stores/palette-request.ts`). The asker then runs `runCommand("palette.toggle")`.
  - `CommandPalette` prop `search?: { readonly projectId: string | null; readonly projectName: string | null } | null`: no command or item rows, only transcript hits, filtered to the project when one is named.
  - Message keys `search.mode.input`, `search.mode.inputIn`, `search.mode.short`, `search.mode.none` (lazy `sidebar` catalog, which the palette registers).

- [ ] **Step 1: Failing tests**

Create `apps/web/src/stores/palette-request.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { usePaletteRequest } from "./palette-request.ts";

beforeEach(() => usePaletteRequest.setState({ search: null }));

describe("the palette request (decision 85)", () => {
  it("is read once: a later plain opening never sees a stale search", () => {
    usePaletteRequest.getState().askSearch("p1");
    expect(usePaletteRequest.getState().take()).toEqual({ projectId: "p1" });
    expect(usePaletteRequest.getState().take()).toBeNull();
    usePaletteRequest.getState().askSearch(null);
    expect(usePaletteRequest.getState().take()).toEqual({ projectId: null });
  });
});
```

Create `apps/web/src/features/commands/palette/CommandPalette.search.test.tsx`:

```tsx
// @vitest-environment happy-dom
import type { SearchHit } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, typeInto } from "../../../testing/dom.ts";
import { shellSession } from "../../../testing/shell-snapshot.ts";
import CommandPalette from "./CommandPalette.tsx";
import type { PaletteItem } from "./rank.ts";

const search = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => ({ rpc: { call: search.call } }),
}));

const NOW = 1_800_000_000_000;
const hit = (id: string, projectId: string, label: string): SearchHit => ({
  sessionId: id,
  entryId: `${id}-e`,
  role: "assistant",
  at: NOW - 60_000,
  snippet: "the \u0002kube\u0003 cluster",
  session: shellSession({ id, name: label, projectId }),
});
const items: PaletteItem[] = [
  { id: "a1", group: "actions", title: "Open settings", searchTerms: ["kube settings"], run: () => {} },
  { id: "s1", group: "sessions", title: "kube-ops", searchTerms: ["kube-ops"], run: () => {} },
];
const input = () => document.querySelector("input") as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? "");
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const open = (scope: { projectId: string | null; projectName: string | null }) =>
  mount(
    <TooltipProvider>
      <CommandPalette open onOpenChange={vi.fn()} items={items} openSession={vi.fn()} search={scope} />
    </TooltipProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  search.call.mockReset();
  search.call.mockResolvedValue({ hits: [hit("h1", "p1", "Cluster notes"), hit("h2", "p2", "Other repo")] });
});
afterEach(() => vi.useRealTimers());

describe("the palette in transcript-search mode (§3.2)", () => {
  it("names the project in its input, lists no command or item, and only that project's hits", async () => {
    await open({ projectId: "p1", projectName: "api" });
    expect(input().getAttribute("aria-label")).toBe("Search transcripts in api");
    expect(document.body.textContent).toContain("Type 3 characters or more to search the transcripts.");
    await typeInto(input(), "kube");
    await wait(150);
    expect(search.call).toHaveBeenCalledWith("search.query", { q: "kube", limit: 20 });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain("Cluster notes");
    expect(document.body.textContent).not.toContain("kube-ops");
    expect(document.body.textContent).not.toContain("Open settings");
  });

  it("lists every project's hits under All projects, and says when none matches", async () => {
    await open({ projectId: null, projectName: null });
    expect(input().getAttribute("aria-label")).toBe("Search transcripts");
    await typeInto(input(), "kube");
    await wait(150);
    expect(options()).toHaveLength(2);
    search.call.mockResolvedValue({ hits: [] });
    await typeInto(input(), "nothing here");
    await wait(150);
    expect(document.body.textContent).toContain("No transcript matches.");
  });
});
```

Create `apps/web/src/routes/shell/palette-search.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { runCommand } from "../../lib/command-registry.ts";
import type { Runtime } from "../../runtime/index.ts";
import { usePaletteRequest } from "../../stores/palette-request.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { press, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
let bed: ReturnType<typeof fakeRuntime>;
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  usePaletteRequest.setState({ search: null });
});

const input = () => document.querySelector("[data-command-palette] input") as HTMLInputElement | null;

describe("the home's Search opens ⌘K for transcripts (§3.2)", () => {
  it("opens in search mode for the project, and the next plain ⌘K is the usual palette", async () => {
    const page = await renderShell("/");
    await settle();
    await act(async () =>
      bed.emitTo(
        "subscribe.shell",
        shellSnapshot([shellSession({ id: "a1", projectId: "p1" })], {
          projects: [shellProject({ id: "p1", name: "api", sessions: 1 })],
        }),
      ),
    );
    await act(async () => {
      usePaletteRequest.getState().askSearch("p1");
      runCommand("palette.toggle");
    });
    await vi.waitFor(() => expect(input()).not.toBeNull(), { timeout: 2_000 });
    expect(input()?.getAttribute("aria-label")).toBe("Search transcripts in api");
    await press(input() as HTMLInputElement, { key: "Escape" });
    await settle();
    await press(document.body, { key: "k", code: "KeyK", ctrlKey: true });
    await vi.waitFor(() => expect(input()).not.toBeNull(), { timeout: 2_000 });
    expect(input()?.getAttribute("aria-label")).toBe("Search commands and sessions");
    await page.unmount();
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/stores/palette-request.test.ts apps/web/src/features/commands/palette/CommandPalette.search.test.tsx apps/web/src/routes/shell/palette-search.test.tsx`
Expected: FAIL — no `palette-request.ts`, no `search` prop.

- [ ] **Step 2: The store and the strings**

Create `apps/web/src/stores/palette-request.ts`:

```ts
import { create } from "zustand";

/** The next palette opening is transcript search only, narrowed to a project when one is named (§3.2, PH8). */
export interface PaletteSearch {
  readonly projectId: string | null;
}

interface PaletteRequestState {
  readonly search: PaletteSearch | null;
  askSearch(projectId: string | null): void;
  /** Reads the request and clears it: a later plain opening never sees a stale one. */
  take(): PaletteSearch | null;
}

/** The home cannot reach the palette's host (features never import routes): it asks here, then runs `palette.toggle`. */
export const usePaletteRequest = create<PaletteRequestState>()((set, get) => ({
  search: null,
  askSearch: (projectId) => set({ search: { projectId } }),
  take: () => {
    const { search } = get();
    set({ search: null });
    return search;
  },
}));
```

In `apps/web/src/i18n/catalog/sidebar.ts`, after `"search.detail"` in the English object:

```ts
  "search.mode.input": "Search transcripts",
  "search.mode.inputIn": "Search transcripts in {project}",
  "search.mode.short": "Type 3 characters or more to search the transcripts.",
  "search.mode.none": "No transcript matches.",
```

and in the French object:

```ts
  "search.mode.input": "Rechercher dans les transcriptions",
  "search.mode.inputIn": "Rechercher dans les transcriptions de {project}",
  "search.mode.short": "Tapez 3 caractères ou plus pour chercher dans les transcriptions.",
  "search.mode.none": "Aucune transcription ne correspond.",
```

- [ ] **Step 3: The palette's search-only mode**

In `apps/web/src/features/commands/palette/CommandPalette.tsx`:
- import `searchText` with `useTranscriptSearch` from `./transcript-search.ts`;
- add to `CommandPaletteProps`:

```ts
  /** Transcript search only (the home's Search, §3.2): no command or item rows, hits of this project when one is named. */
  readonly search?: { readonly projectId: string | null; readonly projectName: string | null } | null;
```

- change the signature to `export default function CommandPalette({ open, onOpenChange, items, openSession, search }: CommandPaletteProps)`;
- rename the local `const search = useTranscriptSearch(query);` to `const found = useTranscriptSearch(query);` and use `found.status` / `found.code` where `search.status` / `search.code` were read;
- replace the ranking and hits lines with:

```ts
  const scope = search ?? null;
  const ranked = useMemo(() => rankItems(scope === null ? items : [], query), [items, query, scope]);
  const found = useTranscriptSearch(query);
  // The daemon's search has no project filter (PH8): the hits it answers are narrowed here.
  const narrowTo = scope === null ? null : scope.projectId;
  const hits = narrowTo === null ? found.hits : found.hits.filter((hit) => hit.session.projectId === narrowTo);
```

and use `hits` wherever `search.hits` was used (`announced`, `choosable`, `TranscriptHits`);
- the input's label: `aria-label={scope === null ? t("commands.palette.input") : scope.projectName === null ? t("search.mode.input") : t("search.mode.inputIn", { project: scope.projectName })}`;
- the empty line:

```tsx
            {searchLine === null ? (
              <Command.Empty className="px-s3 py-s2 text-ui text-muted">
                {scope !== null
                  ? t(searchText(query) === null ? "search.mode.short" : "search.mode.none")
                  : ranked.actionsOnly
                    ? t("commands.palette.emptyActions")
                    : t("commands.palette.empty")}
              </Command.Empty>
            ) : null}
```

- [ ] **Step 4: The host**

`apps/web/src/routes/shell/PaletteHost.tsx`: import `type PaletteSearch, usePaletteRequest` from `../../stores/palette-request.ts`; add `const [search, setSearch] = useState<PaletteSearch | null>(null);`; replace the command and the props:

```tsx
  // A request from the home opens the palette in search mode; a plain ⌘K toggles the usual one.
  useCommand("palette.toggle", () => {
    const asked = usePaletteRequest.getState().take();
    setSearch(asked);
    setOpen((current) => (asked === null ? !current : true));
  });
```

```tsx
      props={{
        open,
        onOpenChange: (next: boolean) => {
          setOpen(next);
          if (!next) setSearch(null);
        },
        items,
        openSession: (id) => go(navigate, pathOfItem({ kind: "session", id })),
        search:
          search === null
            ? null
            : {
                projectId: search.projectId,
                projectName: search.projectId === null ? null : (projects.get(search.projectId)?.name ?? null),
              },
      }}
```

Run: `pnpm exec vitest run --project unit apps/web/src/stores/palette-request.test.ts apps/web/src/features/commands/palette apps/web/src/routes/shell/palette-search.test.tsx apps/web/src/routes/shell/palette-open.test.tsx apps/web/src/routes/shell/PaletteHost.test.tsx`
Expected: PASS (the existing palette tests are unchanged: no `search` prop means the usual palette).

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit apps/web/src/i18n`
Expected: clean.

```bash
git add apps/web/src/stores/palette-request.ts apps/web/src/stores/palette-request.test.ts \
  apps/web/src/features/commands/palette apps/web/src/routes/shell/PaletteHost.tsx \
  apps/web/src/routes/shell/palette-search.test.tsx apps/web/src/i18n/catalog/sidebar.ts
git commit -m "feat(palette): a transcript-search mode the home's Search opens, narrowed to its project"
```

---
### Task 7: The status line (and the home's action types, lazy catalog, test helpers)

Track 2. Spec §3.3, §8 (no polling), §9 ("the status line: parts left out at zero, spend wording and the API-equivalent note, each link's target"). Rulings PH4, PH5, PH10, PH11.

**Files:**
- Create: `apps/web/src/features/home/home-actions.ts`
- Create: `apps/web/src/testing/home-actions.ts`, `apps/web/src/testing/home-fixtures.ts`
- Create: `apps/web/src/i18n/catalog/home.ts`, `apps/web/src/i18n/register-home.ts`
- Modify: `apps/web/src/i18n/index.ts`, `catalog-keys.test.ts`
- Create: `apps/web/src/i18n/lazy-catalog.home.test.ts`
- Create: `apps/web/src/features/home/status-line.vm.ts`, `status-line.vm.test.ts`
- Create: `apps/web/src/features/home/use-spend.ts`
- Create: `apps/web/src/features/home/StatusLine.tsx`, `StatusLine.test.tsx`

**Interfaces:**
- Consumes: `NewLanePrefill` (with `title?`, Task 5), `TriggerPrefill` (Task 5); stores `useLaneStore`, `useTasksStore`, `useInboxStore`; `usage.summary { range: "30d" }`; `formatCost` (`@pap/ui`).
- Produces (`features/home/home-actions.ts`):

```ts
export type HomeSettingsSection = "automation" | "skills" | "mcp" | "approvals";
export type HomeTarget =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "lane"; readonly id: string }
  | { readonly kind: "compare"; readonly id: string }
  | { readonly kind: "tasks" }
  | { readonly kind: "files"; readonly root: string }
  | { readonly kind: "terminal"; readonly id: string }
  | { readonly kind: "settings"; readonly section: HomeSettingsSection };
export interface HomeActions {
  href(target: HomeTarget): string;
  open(target: HomeTarget): void;
  openTree(): void;
  openInbox(): void;
  openSearch(projectId: string | null): void;
  openShortcuts(): void;
  newLane(prefill: NewLanePrefill): boolean;
  newTrigger(projectId: string, prefill: TriggerPrefill): void;
  addProject(onAdded: (projectId: string) => void): void;
}
export interface HomeChord { readonly keys: readonly string[]; readonly joiner: "" | "+" }
export interface HomeShortcuts { readonly lane: HomeChord; readonly search: HomeChord; readonly help: HomeChord }
```

  - `type StatusPart`, `statusParts(input: StatusInput): StatusPart[]` (`status-line.vm.ts`); `useSpend(): UsageSummary | null` (`use-spend.ts`); `StatusLine({ project: ProjectSummary | null; actions: HomeActions })`.
  - Test helpers: `hrefOf(target)`, `fakeHomeActions()`, `SHORTCUTS` (`testing/home-actions.ts`); `taskView(patch)`, `tasksSnapshot(tasks, counts?)`, `usageSummary(patch?)` (`testing/home-fixtures.ts`).
  - Lazy catalog `home.*` (`homeEn`, `homeFr`), registered by `i18n/register-home.ts`.

- [ ] **Step 1: The types, the helpers and the catalog skeleton**

Create `apps/web/src/features/home/home-actions.ts`:

```ts
import type { NewLanePrefill } from "../../stores/new-lane-request.ts";
import type { TriggerPrefill } from "../../stores/trigger-prefill.ts";

/** The Settings sections the home links to. */
export type HomeSettingsSection = "automation" | "skills" | "mcp" | "approvals";

/** What a home link opens: the shapes of the workspace's items, so the shell passes them straight through. */
export type HomeTarget =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "lane"; readonly id: string }
  | { readonly kind: "compare"; readonly id: string }
  | { readonly kind: "tasks" }
  | { readonly kind: "files"; readonly root: string }
  | { readonly kind: "terminal"; readonly id: string }
  | { readonly kind: "settings"; readonly section: HomeSettingsSection };

/**
 * Everything the home opens lives in the shell or in another feature, and features never import each other: the shell
 * builds these (`routes/shell/home-actions.ts`) and hands them in.
 */
export interface HomeActions {
  /** The URL of a target, for a link's `href`. */
  href(target: HomeTarget): string;
  /** Opens a target as a tab (the URL names it). */
  open(target: HomeTarget): void;
  /** The ⌘B tree (the phone's Lists), narrowed to the switcher's project; it holds the archived lanes too. */
  openTree(): void;
  openInbox(): void;
  /** ⌘K in transcript-search mode, narrowed to the project when one is given. */
  openSearch(projectId: string | null): void;
  openShortcuts(): void;
  /** The New lane dialog with this prefill; false when the shell could not open it. */
  newLane(prefill: NewLanePrefill): boolean;
  /** A new trigger's editor in this project, its name and prompt filled in. */
  newTrigger(projectId: string, prefill: TriggerPrefill): void;
  /** The Add project dialog; `onAdded` runs with the new project's id once it is added. */
  addProject(onAdded: (projectId: string) => void): void;
}

/** A chord as the shell formats it ("Ctrl" "K" joined by "+"); no keys: no hint. */
export interface HomeChord {
  readonly keys: readonly string[];
  readonly joiner: "" | "+";
}

/** The hints the home shows (a feature cannot read the keybindings: the shell formats them, web.md "Chord as a prop"). */
export interface HomeShortcuts {
  readonly lane: HomeChord;
  readonly search: HomeChord;
  readonly help: HomeChord;
}
```

Create `apps/web/src/testing/home-actions.ts`:

```ts
import { vi } from "vitest";
import type { HomeActions, HomeShortcuts, HomeTarget } from "../features/home/home-actions.ts";

/** A URL per target, close to the app's (`pathOfItem`), for tests that read links. */
export function hrefOf(target: HomeTarget): string {
  switch (target.kind) {
    case "session":
      return `/s/${target.id}`;
    case "lane":
      return `/lane/${target.id}`;
    case "compare":
      return `/compare/${target.id}`;
    case "tasks":
      return "/tasks";
    case "files":
      return `/explore/${target.root}`;
    case "terminal":
      return `/term/${target.id}`;
    case "settings":
      return `/settings/${target.section}`;
  }
}

/** The shell's actions as spies; `newLane` answers true (the dialog opened) unless a test says otherwise. */
export function fakeHomeActions() {
  return {
    href: vi.fn(hrefOf),
    open: vi.fn<(target: HomeTarget) => void>(),
    openTree: vi.fn<() => void>(),
    openInbox: vi.fn<() => void>(),
    openSearch: vi.fn<(projectId: string | null) => void>(),
    openShortcuts: vi.fn<() => void>(),
    newLane: vi.fn<HomeActions["newLane"]>(() => true),
    newTrigger: vi.fn<HomeActions["newTrigger"]>(),
    addProject: vi.fn<HomeActions["addProject"]>(),
  } satisfies HomeActions;
}

export const SHORTCUTS: HomeShortcuts = {
  lane: { keys: ["Ctrl", "Shift", "L"], joiner: "+" },
  search: { keys: ["Ctrl", "K"], joiner: "+" },
  help: { keys: ["?"], joiner: "+" },
};
```

Create `apps/web/src/testing/home-fixtures.ts`:

```ts
import type { TaskView, UsageSummary } from "@pap/contracts";

/** A finished task of project p1, from trigger g1. */
export const taskView = (patch: Partial<TaskView> & { id: string }): TaskView => ({
  triggerId: "g1",
  triggerName: "nightly",
  projectId: "p1",
  state: "done",
  reason: null,
  origin: "schedule",
  title: `task ${patch.id}`,
  detail: null,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
  sessionId: null,
  needsInput: false,
  costUsd: 0,
  resetAt: null,
  toolsReleased: false,
  ...patch,
});

/** The first event of the `tasks` stream. */
export const tasksSnapshot = (
  tasks: TaskView[],
  counts: { readonly paused?: boolean; readonly budgetUsd?: number | null } = {},
) => ({
  kind: "snapshot",
  paused: counts.paused ?? false,
  slots: 2,
  running: tasks.filter((task) => task.state === "running").length,
  queued: 0,
  quietHours: false,
  todayUsd: 0,
  budgetUsd: counts.budgetUsd ?? null,
  tasks,
  truncated: false,
  triggers: [],
  failures: [],
});

/** `usage.summary`'s answer: one model row when there were runs. */
export const usageSummary = (
  patch: { readonly costUsd?: number; readonly runs?: number; readonly billing?: "api" | "subscription" } = {},
): UsageSummary => ({
  from: 0,
  to: 1,
  timeZone: "UTC",
  totals: { costUsd: patch.costUsd ?? 0, tokens: 0, runs: patch.runs ?? 0 },
  byOrigin: [],
  byModel:
    (patch.runs ?? 0) > 0
      ? [
          {
            costUsd: patch.costUsd ?? 0,
            tokens: 0,
            runs: patch.runs ?? 0,
            provider: "anthropic",
            model: "sonnet",
            billing: patch.billing ?? "api",
          },
        ]
      : [],
  metrics: false,
  otlpHost: null,
});
```

Create `apps/web/src/i18n/catalog/home.ts` (Tasks 8, 10 and 11 add their keys to both objects):

```ts
/** The project home's body and picker (decision 85): one lazy catalog, registered by `register-home.ts`. */
export const homeEn = {
  "home.status.label": "Status",
  "home.status.lanes.one": "{count} active lane",
  "home.status.lanes.other": "{count} active lanes",
  "home.status.tasks.one": "{count} running task",
  "home.status.tasks.other": "{count} running tasks",
  "home.status.inbox": "Inbox {count}",
  "home.status.spend": "30 days {amount}",
  "home.status.spendApi": "30 days {amount} (API-equivalent)",
  "home.status.noSpend": "No spend yet",
  "home.status.spendScope": "All your projects, last 30 days",
} as const;

export const homeFr: { readonly [K in keyof typeof homeEn]: string } = {
  "home.status.label": "État",
  "home.status.lanes.one": "{count} lane active",
  "home.status.lanes.other": "{count} lanes actives",
  "home.status.tasks.one": "{count} tâche en cours",
  "home.status.tasks.other": "{count} tâches en cours",
  "home.status.inbox": "Boîte {count}",
  "home.status.spend": "30 jours {amount}",
  "home.status.spendApi": "30 jours {amount} (équivalent API)",
  "home.status.noSpend": "Aucune dépense pour l'instant",
  "home.status.spendScope": "Tous vos projets, 30 derniers jours",
};
```

Create `apps/web/src/i18n/register-home.ts`:

```ts
import { homeEn, homeFr } from "./catalog/home.ts";
import { registerCatalog } from "./index.ts";

// Every chunk that shows home keys (the home's body, its picker) imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: homeEn, fr: homeFr });
```

In `apps/web/src/i18n/index.ts`, add `import type { homeEn } from "./catalog/home.ts";` and `| keyof typeof homeEn` to `MessageKey`. In `catalog-keys.test.ts`, import `{ homeEn, homeFr } from "./catalog/home.ts"` and add `home: Object.keys(homeEn),` / `home: Object.keys(homeFr),` to the two lists.

Create `apps/web/src/i18n/lazy-catalog.home.test.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { homeEn, homeFr } from "./catalog/home.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

/** The files of the home's lazy chunks that name its keys (Tasks 8, 10 and 11 add theirs). */
const IN_CHUNK = new Set(["features/home/StatusLine.tsx"]);

describe("lazy catalog (project home)", () => {
  it("has the same keys and slots in English and French", () => {
    expect(Object.keys(homeFr)).toEqual(Object.keys(homeEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(homeEn) as Array<keyof typeof homeEn>) {
      expect(homeFr[key], key).not.toBe("");
      expect(slots(homeFr[key]), key).toEqual(slots(homeEn[key]));
    }
  });

  it("is named only by the home's lazy files: the eager composer can never render a raw key", () => {
    expect([...IN_CHUNK].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || IN_CHUNK.has(name)) continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]home\./.test(code)) offenders.push(`${name}: home key`);
      if (/catalog\/home\.ts"|register-home\.ts"/.test(code)) offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });

  it("stays out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("home."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("home."))).toEqual([]);
  });
});
```

(Task 7 creates `StatusLine.tsx` below, so the first test passes once Step 4 is done.)

- [ ] **Step 2: Failing view-model test**

Create `apps/web/src/features/home/status-line.vm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { taskView, usageSummary } from "../../testing/home-fixtures.ts";
import { laneView } from "../../testing/lane-fixtures.ts";
import { statusParts } from "./status-line.vm.ts";

const api = { id: "p1", root: "/w/api" };
const lanes = [
  laneView({ id: "a-1a2b", projectRoot: "/w/api" }),
  laneView({ id: "b-1a2b", projectRoot: "/w/api", state: "creating" }),
  laneView({ id: "c-1a2b", projectRoot: "/w/web" }),
];
const tasks = [
  taskView({ id: "t1", state: "running" }),
  taskView({ id: "t2", state: "running", projectId: "p2" }),
  taskView({ id: "t3", state: "queued" }),
];

describe("statusParts (§3.3)", () => {
  it("counts the project's active lanes and running tasks, the owner's unread items, and the 30-day spend", () => {
    expect(statusParts({ project: api, lanes, tasks, unread: 3, spend: usageSummary({ costUsd: 4.2, runs: 2 }) })).toEqual([
      { kind: "lanes", count: 1 },
      { kind: "tasks", count: 1 },
      { kind: "inbox", count: 3 },
      { kind: "spend", usd: 4.2, none: false, apiEquivalent: false },
    ]);
  });

  it("counts every project under All projects", () => {
    expect(statusParts({ project: null, lanes, tasks, unread: 0, spend: null })).toEqual([
      { kind: "lanes", count: 2 },
      { kind: "tasks", count: 2 },
    ]);
  });

  it("leaves out a part with nothing to show, never the spend, and notes a subscription's figure", () => {
    expect(statusParts({ project: api, lanes: [], tasks: [], unread: 0, spend: usageSummary() })).toEqual([
      { kind: "spend", usd: 0, none: true, apiEquivalent: false },
    ]);
    expect(
      statusParts({ project: api, lanes: [], tasks: [], unread: 0, spend: usageSummary({ costUsd: 1, runs: 1, billing: "subscription" }) }),
    ).toEqual([{ kind: "spend", usd: 1, none: false, apiEquivalent: true }]);
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/status-line.vm.test.ts`
Expected: FAIL — `status-line.vm.ts` does not exist.

- [ ] **Step 3: The view-model and the spend hook**

Create `apps/web/src/features/home/status-line.vm.ts`:

```ts
import type { LaneView, TaskView, UsageSummary } from "@pap/contracts";

export type StatusPart =
  | { readonly kind: "lanes"; readonly count: number }
  | { readonly kind: "tasks"; readonly count: number }
  | { readonly kind: "inbox"; readonly count: number }
  | { readonly kind: "spend"; readonly usd: number; readonly none: boolean; readonly apiEquivalent: boolean };

export interface StatusInput {
  /** The switcher's project; null: every project. */
  readonly project: { readonly id: string; readonly root: string } | null;
  readonly lanes: Iterable<LaneView>;
  readonly tasks: readonly TaskView[];
  /** The owner's unread Inbox items: they carry no project (PH11). */
  readonly unread: number;
  /** `usage.summary` over 30 days (PH4); null while it loads or after a failure, and then the part is left out. */
  readonly spend: UsageSummary | null;
}

/** §3.3: `3 active lanes · 1 running task · Inbox 3 · 30 days $4.20`. A part at zero is left out; the spend never is. */
export function statusParts(input: StatusInput): StatusPart[] {
  const { project } = input;
  const lanes = [...input.lanes].filter(
    (lane) => lane.state === "active" && (project === null || lane.projectRoot === project.root),
  ).length;
  const tasks = input.tasks.filter(
    (task) => task.state === "running" && (project === null || task.projectId === project.id),
  ).length;
  const parts: StatusPart[] = [];
  if (lanes > 0) parts.push({ kind: "lanes", count: lanes });
  if (tasks > 0) parts.push({ kind: "tasks", count: tasks });
  if (input.unread > 0) parts.push({ kind: "inbox", count: input.unread });
  if (input.spend !== null)
    parts.push({
      kind: "spend",
      usd: input.spend.totals.costUsd,
      none: input.spend.totals.runs === 0,
      // A subscription bills no tokens: its figure is what the API would have charged (finops.md).
      apiEquivalent: input.spend.byModel.some((row) => row.billing === "subscription"),
    });
  return parts;
}
```

Create `apps/web/src/features/home/use-spend.ts`:

```ts
import { UsageSummary } from "@pap/contracts";
import { useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

/**
 * The owner's spend over 30 days (PH4), asked once when the home mounts: no polling (§8). A failure or an answer this
 * build cannot read leaves it null, and the status line goes on without its spend.
 */
export function useSpend(): UsageSummary | null {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("usage.summary", { range: "30d" })
      .then(
        (answer) => {
          const parsed = UsageSummary.safeParse(answer);
          if (current && parsed.success) setSummary(parsed.data);
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, []);
  return summary;
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/status-line.vm.test.ts`
Expected: PASS.

- [ ] **Step 4: Failing component test**

Create `apps/web/src/features/home/StatusLine.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { click, mount, settle } from "../../testing/dom.ts";
import { fakeHomeActions } from "../../testing/home-actions.ts";
import { tasksSnapshot, taskView, usageSummary } from "../../testing/home-fixtures.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject } from "../../testing/shell-snapshot.ts";
import { StatusLine } from "./StatusLine.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
let bed: ReturnType<typeof fakeRuntime>;
let actions: ReturnType<typeof fakeHomeActions>;
const line = () => document.querySelector("[data-home-status]") as HTMLElement | null;
const parts = () => [...(line()?.querySelectorAll("a, button") ?? [])];
const words = () => parts().map((node) => node.textContent);
const show = async (project: typeof api | null = api) => {
  await mount(<StatusLine project={project} actions={actions} />);
  await settle();
};
const busyProject = () => {
  useLaneStore.getState().apply(
    laneSnapshot([
      laneView({ id: "a-1a2b", projectRoot: "/w/api" }),
      laneView({ id: "b-1a2b", projectRoot: "/w/api" }),
      laneView({ id: "c-1a2b", projectRoot: "/w/api" }),
      laneView({ id: "d-1a2b", projectRoot: "/w/web" }),
    ]),
  );
  useTasksStore.getState().apply(tasksSnapshot([taskView({ id: "t1", state: "running" })]));
  useInboxStore.getState().apply({ kind: "counts", unread: 3, toHandle: 1 });
};

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["usage.summary"] = () => usageSummary({ costUsd: 4.2, runs: 3 });
  actions = fakeHomeActions();
  useLaneStore.getState().reset();
  useTasksStore.getState().reset();
  useInboxStore.getState().reset();
});
afterEach(() => setLocale("en"));

describe("the status line (§3.3)", () => {
  it("reads 3 active lanes · 1 running task · Inbox 3 · 30 days $4.20, the spend owner-wide", async () => {
    busyProject();
    await show();
    expect(words()).toEqual([
      "3 active lanes",
      "1 running task",
      "Inbox 3",
      "30 days $4.20 All your projects, last 30 days",
    ]);
    expect(bed.called("usage.summary").map((call) => call.params)).toEqual([{ range: "30d" }]);
  });

  it("leaves out a part with nothing to show, never the spend, which says no spend yet", async () => {
    bed.handlers["usage.summary"] = () => usageSummary({ runs: 0 });
    await show();
    expect(words()).toEqual(["No spend yet All your projects, last 30 days"]);
  });

  it("says API-equivalent when a subscription paid for part of it", async () => {
    bed.handlers["usage.summary"] = () => usageSummary({ costUsd: 4.2, runs: 2, billing: "subscription" });
    await show();
    expect(words()).toEqual(["30 days $4.20 (API-equivalent) All your projects, last 30 days"]);
  });

  it("goes on without its spend when the summary fails", async () => {
    busyProject();
    bed.handlers["usage.summary"] = () => {
      throw new RpcError("timeout");
    };
    await show();
    expect(words()).toEqual(["3 active lanes", "1 running task", "Inbox 3"]);
  });

  it("opens each part's view: the tree, the tasks board, the Inbox, Settings › Automation", async () => {
    busyProject();
    await show();
    const [lanes, tasks, inbox, spend] = parts() as HTMLElement[];
    expect(lanes?.tagName).toBe("BUTTON");
    expect(tasks?.getAttribute("href")).toBe("/tasks");
    expect(spend?.getAttribute("href")).toBe("/settings/automation");
    for (const part of [lanes, tasks, inbox, spend]) await click(part as HTMLElement);
    expect(actions.openTree).toHaveBeenCalledOnce();
    expect(actions.openInbox).toHaveBeenCalledOnce();
    expect(actions.open.mock.calls).toEqual([[{ kind: "tasks" }], [{ kind: "settings", section: "automation" }]]);
  });

  it("speaks French", async () => {
    setLocale("fr");
    busyProject();
    await show();
    expect(words()[0]).toBe("3 lanes actives");
    expect(words()[3]).toBe("30 jours $4.20 Tous vos projets, 30 derniers jours");
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/StatusLine.test.tsx`
Expected: FAIL — `StatusLine.tsx` does not exist.

- [ ] **Step 5: The component**

Create `apps/web/src/features/home/StatusLine.tsx`:

```tsx
import "../../i18n/register-home.ts";
import type { ProjectSummary } from "@pap/contracts";
import { formatCost, Tooltip } from "@pap/ui";
import { Fragment, type ReactNode } from "react";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import type { HomeActions, HomeTarget } from "./home-actions.ts";
import { type StatusPart, statusParts } from "./status-line.vm.ts";
import { useSpend } from "./use-spend.ts";

/** A part looks like a link either way: a link when it opens a tab, a button when it opens a drawer (PH10). */
const PART_CLASSES = "rounded-sm text-fg underline focus-ring can-hover:hover:text-agent";

interface Props {
  readonly project: ProjectSummary | null;
  readonly actions: HomeActions;
}

/** §3.3: one line, every part clickable; it reads the stores the shell and the home already feed, and one summary. */
export function StatusLine({ project, actions }: Props) {
  const t = useT();
  const locale = useLocale();
  const lanes = useLaneStore((state) => state.view.lanes);
  const tasks = useTasksStore((state) => state.view.list);
  const unread = useInboxStore((state) => state.view.unread);
  const spend = useSpend();
  const parts = statusParts({ project, lanes: lanes.values(), tasks, unread, spend });
  if (parts.length === 0) return null;

  const link = (target: HomeTarget, children: ReactNode) => (
    <a
      href={actions.href(target)}
      className={PART_CLASSES}
      onClick={(event) => {
        event.preventDefault();
        actions.open(target);
      }}
    >
      {children}
    </a>
  );
  const show = (part: StatusPart): ReactNode => {
    switch (part.kind) {
      case "lanes":
        return (
          <button type="button" className={PART_CLASSES} onClick={() => actions.openTree()}>
            {plural(locale, "home.status.lanes", part.count)}
          </button>
        );
      case "tasks":
        return link({ kind: "tasks" }, plural(locale, "home.status.tasks", part.count));
      case "inbox":
        return (
          <button type="button" className={PART_CLASSES} onClick={() => actions.openInbox()}>
            {t("home.status.inbox", { count: part.count })}
          </button>
        );
      case "spend": {
        const amount = formatCost(part.usd);
        const shown = part.none
          ? t("home.status.noSpend")
          : t(part.apiEquivalent ? "home.status.spendApi" : "home.status.spend", { amount });
        return (
          <Tooltip label={t("home.status.spendScope")}>
            {link(
              { kind: "settings", section: "automation" },
              <>
                {shown}
                <span className="sr-only">
                  {" "}
                  {t("home.status.spendScope")}
                </span>
              </>,
            )}
          </Tooltip>
        );
      }
    }
  };
  return (
    <div
      role="group"
      aria-label={t("home.status.label")}
      data-home-status=""
      className="flex flex-wrap items-center gap-s1 text-ui text-muted"
    >
      {parts.map((part, index) => (
        <Fragment key={part.kind}>
          {index > 0 ? <span aria-hidden="true">{"·"}</span> : null}
          {show(part)}
        </Fragment>
      ))}
    </div>
  );
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home apps/web/src/i18n`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm knip`
Expected: clean.

```bash
git add apps/web/src/features/home apps/web/src/testing/home-actions.ts apps/web/src/testing/home-fixtures.ts \
  apps/web/src/i18n
git commit -m "feat(home): the status line, with the home's action types and lazy catalog"
```

---
### Task 8: Recent work

Track 2. Spec §3.4, §9 ("Recent work: merge order, filters, 'Show more', a fan-out row reopening compare"), §10 (the old home's list tests move here). Review Focus 5.

**Files:**
- Create: `apps/web/src/features/home/recent-work.vm.ts`, `recent-work.vm.test.ts`
- Create: `apps/web/src/features/home/use-archived-lanes.ts`
- Create: `apps/web/src/features/home/RecentWork.tsx`, `RecentWork.test.tsx`
- Modify: `apps/web/src/i18n/catalog/home.ts`, `apps/web/src/i18n/lazy-catalog.home.test.ts`

**Interfaces:**
- Consumes: `HomeActions`, `HomeTarget` (Task 7); `isSnoozed` (contracts); `sessionLabel` (`lib/session-label.ts`); `formatAge` (`i18n/age.ts`); stores `useShellStore`, `useLaneStore`, `useTasksStore`; `lanes.listArchived {}` → `{ lanes: LaneView[]; hasMore: boolean }`.
- Produces (`features/home/recent-work.vm.ts`):

```ts
export const RECENT_PAGE = 20;
export const RECENT_FILTERS = ["all", "sessions", "lanes", "tasks"] as const;
export type RecentFilter = (typeof RECENT_FILTERS)[number];
export type RecentRow =
  | (RowBase & { readonly kind: "session"; readonly state: SessionStatus })
  | (RowBase & { readonly kind: "lane"; readonly state: LaneView["state"] })
  | (RowBase & { readonly kind: "fanout"; readonly state: "active" | "archived"; readonly lanes: number })
  | (RowBase & { readonly kind: "task"; readonly state: TaskState });
// RowBase = { key: string; title: string; at: number; projectId: string | null; target: HomeTarget }
export interface RecentInput { project; sessions; projects; lanes; fanouts; tasks; now }
export function recentRows(input: RecentInput): RecentRow[];
export function filterRows(rows: readonly RecentRow[], filter: RecentFilter): RecentRow[];
```

  and `useArchivedLanes(): readonly LaneView[]`, `RecentWork({ project: ProjectSummary | null; actions: HomeActions })`.

- [ ] **Step 1: Failing view-model tests (Review Focus 5)**

Create `apps/web/src/features/home/recent-work.vm.test.ts`:

```ts
import type { ShellSession } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { taskView } from "../../testing/home-fixtures.ts";
import { fanoutView, laneView } from "../../testing/lane-fixtures.ts";
import { shellProject, shellSession } from "../../testing/shell-snapshot.ts";
import { filterRows, type RecentInput, recentRows } from "./recent-work.vm.ts";

const NOW = 1_800_000_000_000;
const FANOUT = "0123456789abcdef";
const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 2 });
const web = shellProject({ id: "p2", name: "web", root: "/w/web", sessions: 1 });
const held = (...list: ShellSession[]) => new Map(list.map((session) => [session.id, session]));
const input = (patch: Partial<RecentInput> = {}): RecentInput => ({
  project: api,
  sessions: new Map(),
  projects: new Map([
    [api.id, api],
    [web.id, web],
  ]),
  lanes: [],
  fanouts: new Map(),
  tasks: [],
  now: NOW,
  ...patch,
});

describe("recentRows (§3.4)", () => {
  it("merges the project's sessions, lanes and tasks, newest activity first, each with its target", () => {
    const rows = recentRows(
      input({
        sessions: held(
          shellSession({ id: "s1", projectId: "p1", updatedAt: 30, name: "Fix login" }),
          shellSession({ id: "s2", projectId: "p2", updatedAt: 90 }),
        ),
        lanes: [laneView({ id: "l-1a2b", projectRoot: "/w/api", createdAt: 50, title: "Cache" })],
        tasks: [taskView({ id: "t1", createdAt: 10, endedAt: 70, title: "Nightly" })],
      }),
    );
    expect(rows.map((row) => [row.kind, row.title, row.at])).toEqual([
      ["task", "Nightly", 70],
      ["lane", "Cache", 50],
      ["session", "Fix login", 30],
    ]);
    expect(rows.map((row) => row.target)).toEqual([
      { kind: "tasks" },
      { kind: "lane", id: "l-1a2b" },
      { kind: "session", id: "s1" },
    ]);
  });

  it("leaves out archived, settled and snoozed sessions, and labels the others by name, preview or folder", () => {
    const rows = recentRows(
      input({
        sessions: held(
          shellSession({ id: "a", projectId: "p1", archivedAt: 5, updatedAt: 9 }),
          shellSession({ id: "b", projectId: "p1", settledAt: 5, updatedAt: 8 }),
          shellSession({ id: "c", projectId: "p1", snoozedUntil: NOW + 60_000, updatedAt: 7 }),
          shellSession({ id: "d", projectId: "p1", preview: "fix the tests", updatedAt: 6 }),
          shellSession({ id: "e", projectId: "p1", cwd: "/w/api/e", updatedAt: 5 }),
        ),
      }),
    );
    expect(rows.map((row) => row.title)).toEqual(["fix the tests", "e"]);
  });

  it("does not list a lane's or a task's session twice (Review Focus 5)", () => {
    const rows = recentRows(
      input({
        sessions: held(
          shellSession({ id: "lane-s", projectId: "p1", cwd: "/p/worktrees/l-1a2b", updatedAt: 80 }),
          shellSession({ id: "deep", projectId: "p1", cwd: "/p/worktrees/l-1a2b/src", updatedAt: 81 }),
          shellSession({ id: "task-s", projectId: "p1", cwd: "/w/api", updatedAt: 82 }),
          shellSession({ id: "mine", projectId: "p1", cwd: "/w/api", updatedAt: 83 }),
        ),
        lanes: [laneView({ id: "l-1a2b", projectRoot: "/w/api", primarySessionId: "lane-s", createdAt: 1 })],
        tasks: [taskView({ id: "t1", sessionId: "task-s", createdAt: 2 })],
      }),
    );
    expect(rows.map((row) => [row.key, row.at])).toEqual([
      ["session:mine", 83],
      ["task:t1", 82],
      ["lane:l-1a2b", 80],
    ]);
    expect(rows.find((row) => row.kind === "task")?.target).toEqual({ kind: "session", id: "task-s" });
  });

  it("groups a fan-out's lanes, live and archived, into one row that reopens its compare (Review Focus 5)", () => {
    const rows = recentRows(
      input({
        lanes: [
          laneView({ id: "a-1a2b", projectRoot: "/w/api", fanoutId: FANOUT, fanoutSlot: 0, createdAt: 10 }),
          laneView({ id: "b-1a2b", projectRoot: "/w/api", fanoutId: FANOUT, state: "archived", archivedAt: 40 }),
          // The same lane in the archived page as well: the live copy counts, once.
          laneView({ id: "a-1a2b", projectRoot: "/w/api", fanoutId: FANOUT, state: "archived", archivedAt: 99 }),
        ],
        fanouts: new Map([[FANOUT, fanoutView({ id: FANOUT, prompt: "Try three caches\nwith details" })]]),
      }),
    );
    expect(rows).toEqual([
      {
        kind: "fanout",
        key: `fanout:${FANOUT}`,
        title: "Try three caches",
        state: "active",
        lanes: 2,
        at: 40,
        projectId: "p1",
        target: { kind: "compare", id: FANOUT },
      },
    ]);
  });

  it("calls a fan-out whose lanes are all archived archived, and still reopens its compare", () => {
    const rows = recentRows(
      input({
        lanes: [
          laneView({ id: "a-1a2b", projectRoot: "/w/api", fanoutId: FANOUT, state: "archived", archivedAt: 3, title: "One" }),
        ],
      }),
    );
    expect(rows).toMatchObject([{ kind: "fanout", state: "archived", title: "One", target: { kind: "compare", id: FANOUT } }]);
  });

  it("lists every project's work under All projects", () => {
    const rows = recentRows(
      input({
        project: null,
        sessions: held(
          shellSession({ id: "s1", projectId: "p1", updatedAt: 2 }),
          shellSession({ id: "s2", projectId: "p2", updatedAt: 1 }),
        ),
        lanes: [laneView({ id: "w-1a2b", projectRoot: "/w/web", createdAt: 3 })],
      }),
    );
    expect(rows.map((row) => [row.key, row.projectId])).toEqual([
      ["lane:w-1a2b", "p2"],
      ["session:s1", "p1"],
      ["session:s2", "p2"],
    ]);
  });
});

describe("filterRows", () => {
  it("keeps sessions, lanes with their fan-outs, or tasks", () => {
    const rows = recentRows(
      input({
        sessions: held(shellSession({ id: "s1", projectId: "p1", updatedAt: 4 })),
        lanes: [
          laneView({ id: "l-1a2b", projectRoot: "/w/api", createdAt: 3 }),
          laneView({ id: "f-1a2b", projectRoot: "/w/api", fanoutId: FANOUT, createdAt: 2 }),
        ],
        tasks: [taskView({ id: "t1", createdAt: 1 })],
      }),
    );
    expect(filterRows(rows, "all").map((row) => row.kind)).toEqual(["session", "lane", "fanout", "task"]);
    expect(filterRows(rows, "sessions").map((row) => row.kind)).toEqual(["session"]);
    expect(filterRows(rows, "lanes").map((row) => row.kind)).toEqual(["lane", "fanout"]);
    expect(filterRows(rows, "tasks").map((row) => row.kind)).toEqual(["task"]);
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/recent-work.vm.test.ts`
Expected: FAIL — `recent-work.vm.ts` does not exist.

- [ ] **Step 2: The view-model**

Create `apps/web/src/features/home/recent-work.vm.ts`:

```ts
import {
  type FanoutView,
  isSnoozed,
  type LaneView,
  type ProjectSummary,
  type SessionStatus,
  type ShellSession,
  type TaskState,
  type TaskView,
} from "@pap/contracts";
import { sessionLabel } from "../../lib/session-label.ts";
import type { HomeTarget } from "./home-actions.ts";

/** Rows shown at first, and added by each "Show more" (§3.4). */
export const RECENT_PAGE = 20;
export const RECENT_FILTERS = ["all", "sessions", "lanes", "tasks"] as const;
export type RecentFilter = (typeof RECENT_FILTERS)[number];

interface RowBase {
  readonly key: string;
  readonly title: string;
  /** Last activity, in milliseconds. */
  readonly at: number;
  readonly projectId: string | null;
  readonly target: HomeTarget;
}

export type RecentRow =
  | (RowBase & { readonly kind: "session"; readonly state: SessionStatus })
  | (RowBase & { readonly kind: "lane"; readonly state: LaneView["state"] })
  | (RowBase & { readonly kind: "fanout"; readonly state: "active" | "archived"; readonly lanes: number })
  | (RowBase & { readonly kind: "task"; readonly state: TaskState });

export interface RecentInput {
  /** The switcher's project; null: every project. */
  readonly project: { readonly id: string; readonly root: string } | null;
  readonly sessions: ReadonlyMap<string, ShellSession>;
  readonly projects: ReadonlyMap<string, ProjectSummary>;
  /** Live lanes first, then the archived page (`lanes.listArchived`): a lane in both counts once, as live. */
  readonly lanes: readonly LaneView[];
  readonly fanouts: ReadonlyMap<string, FanoutView>;
  readonly tasks: readonly TaskView[];
  readonly now: number;
}

const firstLine = (text: string): string =>
  text
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? "";
const inside = (cwd: string, folder: string): boolean => cwd === folder || cwd.startsWith(`${folder}/`);

/**
 * §3.4: one list for the project — sessions, lanes (live and archived), tasks, and fan-outs grouped from the lanes that
 * share a `fanoutId` — ordered by last activity. A session that belongs to a lane (its folder is the worktree) or to a
 * task is its lane's or task's row, never a row of its own (Review Focus 5).
 */
export function recentRows(input: RecentInput): RecentRow[] {
  const byId = new Map<string, LaneView>();
  for (const lane of input.lanes) if (!byId.has(lane.id)) byId.set(lane.id, lane);
  const lanes = [...byId.values()];
  const projectOfRoot = new Map([...input.projects.values()].map((project) => [project.root, project.id]));
  const wanted = (projectId: string | null): boolean => input.project === null || projectId === input.project.id;
  const updated = (sessionId: string | null): number =>
    sessionId === null ? 0 : (input.sessions.get(sessionId)?.updatedAt ?? 0);
  const laneAt = (lane: LaneView): number =>
    Math.max(lane.createdAt, lane.archivedAt ?? 0, lane.firstRunEndedAt ?? 0, updated(lane.primarySessionId));
  const taskSessions = new Set(input.tasks.flatMap((task) => (task.sessionId === null ? [] : [task.sessionId])));

  const rows: RecentRow[] = [];
  for (const session of input.sessions.values()) {
    if (session.archivedAt !== null || session.settledAt !== null || isSnoozed(session, input.now)) continue;
    if (!wanted(session.projectId) || taskSessions.has(session.id)) continue;
    if (lanes.some((lane) => inside(session.cwd, lane.worktree))) continue;
    rows.push({
      kind: "session",
      key: `session:${session.id}`,
      title: sessionLabel(session) || session.cwd,
      state: session.status,
      at: session.updatedAt,
      projectId: session.projectId,
      target: { kind: "session", id: session.id },
    });
  }
  const groups = new Map<string, LaneView[]>();
  for (const lane of lanes) {
    if (input.project !== null && lane.projectRoot !== input.project.root) continue;
    if (lane.fanoutId !== null) {
      groups.set(lane.fanoutId, [...(groups.get(lane.fanoutId) ?? []), lane]);
      continue;
    }
    rows.push({
      kind: "lane",
      key: `lane:${lane.id}`,
      title: lane.title || lane.branch,
      state: lane.state,
      at: laneAt(lane),
      projectId: projectOfRoot.get(lane.projectRoot) ?? null,
      target: { kind: "lane", id: lane.id },
    });
  }
  for (const [fanoutId, members] of groups) {
    const first = members[0];
    if (first === undefined) continue;
    rows.push({
      kind: "fanout",
      key: `fanout:${fanoutId}`,
      title: firstLine(input.fanouts.get(fanoutId)?.prompt ?? "") || first.title || first.branch,
      state: members.every((lane) => lane.state === "archived") ? "archived" : "active",
      lanes: members.length,
      at: Math.max(...members.map(laneAt)),
      projectId: projectOfRoot.get(first.projectRoot) ?? null,
      target: { kind: "compare", id: fanoutId },
    });
  }
  for (const task of input.tasks) {
    if (!wanted(task.projectId)) continue;
    rows.push({
      kind: "task",
      key: `task:${task.id}`,
      title: task.title,
      state: task.state,
      at: Math.max(task.endedAt ?? task.startedAt ?? task.createdAt, updated(task.sessionId)),
      projectId: task.projectId,
      target: task.sessionId === null ? { kind: "tasks" } : { kind: "session", id: task.sessionId },
    });
  }
  return rows.sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
}

/** The filter chips: All · Sessions · Lanes (fan-outs with them) · Tasks. */
export function filterRows(rows: readonly RecentRow[], filter: RecentFilter): RecentRow[] {
  switch (filter) {
    case "all":
      return [...rows];
    case "sessions":
      return rows.filter((row) => row.kind === "session");
    case "lanes":
      return rows.filter((row) => row.kind === "lane" || row.kind === "fanout");
    case "tasks":
      return rows.filter((row) => row.kind === "task");
  }
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/recent-work.vm.test.ts`
Expected: PASS.

- [ ] **Step 3: Failing component test (the old home's list tests, moved)**

Create `apps/web/src/features/home/RecentWork.test.tsx`:

```tsx
// @vitest-environment happy-dom
import type { ShellSession } from "@pap/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeHomeActions } from "../../testing/home-actions.ts";
import { tasksSnapshot, taskView } from "../../testing/home-fixtures.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { RecentWork } from "./RecentWork.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const FANOUT = "0123456789abcdef";
const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
const web = shellProject({ id: "p2", name: "web", root: "/w/web", sessions: 1 });
let bed: ReturnType<typeof fakeRuntime>;
let actions: ReturnType<typeof fakeHomeActions>;
const listed = (...sessions: ShellSession[]) =>
  useShellStore.getState().apply(shellSnapshot(sessions, { projects: [api, web] }));
const links = () => [...document.querySelectorAll("[data-recent-row] a")];
const show = async (project: typeof api | null = api) => {
  const page = await mount(<RecentWork project={project} actions={actions} />);
  await settle();
  return page.container;
};

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["lanes.listArchived"] = () => ({ lanes: [], hasMore: false });
  actions = fakeHomeActions();
  useShellStore.getState().reset();
  useLaneStore.getState().reset();
  useTasksStore.getState().reset();
});

describe("Recent work (§3.4)", () => {
  it("lists the project's work, the most recent first, each a link to its item with type, state and age", async () => {
    listed(
      shellSession({ id: "a", projectId: "p1", cwd: "/w/api", updatedAt: 10, name: "Old" }),
      shellSession({ id: "b", projectId: "p1", cwd: "/w/api", updatedAt: 20, name: "New", status: "running" }),
      shellSession({ id: "c", projectId: "p2", cwd: "/w/web", updatedAt: 30, name: "Elsewhere" }),
    );
    await show();
    expect(links().map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["New", "/s/b"],
      ["Old", "/s/a"],
    ]);
    const first = document.querySelector("[data-recent-row]") as HTMLElement;
    expect(text(first)).toContain("Session");
    expect(text(first)).toContain("Working");
    await click(links()[0] as HTMLElement);
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "session", id: "b" });
    expect(bed.called("sessions.list")).toEqual([]);
  });

  it("shows a name that looks like markup as text only", async () => {
    listed(shellSession({ id: "a", projectId: "p1", name: "<b>x</b>" }));
    const container = await show();
    expect(links().map((link) => link.textContent)).toEqual(["<b>x</b>"]);
    expect(container.querySelector("b")).toBeNull();
  });

  it("shows 20 rows, then 20 more with each Show more", async () => {
    listed(
      ...Array.from({ length: 45 }, (_, i) =>
        shellSession({ id: `s${i}`, projectId: "p1", cwd: "/w/api", updatedAt: i + 1 }),
      ),
    );
    const container = await show();
    expect(links()).toHaveLength(20);
    expect(links()[0]?.getAttribute("href")).toBe("/s/s44");
    await click(button(container, "Show more"));
    expect(links()).toHaveLength(40);
    await click(button(container, "Show more"));
    expect(links()).toHaveLength(45);
    expect(() => button(container, "Show more")).toThrow();
  });

  it("filters by Sessions, Lanes and Tasks, the pressed chip said", async () => {
    listed(shellSession({ id: "s1", projectId: "p1", cwd: "/w/api", updatedAt: 3 }));
    useLaneStore.getState().apply(laneSnapshot([laneView({ id: "l-1a2b", projectRoot: "/w/api", createdAt: 2 })]));
    useTasksStore.getState().apply(tasksSnapshot([taskView({ id: "t1", createdAt: 1 })]));
    const container = await show();
    const kinds = () => [...document.querySelectorAll("[data-recent-row]")].map((row) => row.getAttribute("data-recent-row"));
    expect(kinds()).toEqual(["session", "lane", "task"]);
    await click(button(container, "Lanes"));
    expect(kinds()).toEqual(["lane"]);
    expect(button(container, "Lanes").getAttribute("aria-pressed")).toBe("true");
    await click(button(container, "Tasks"));
    expect(kinds()).toEqual(["task"]);
    await click(button(container, "Sessions"));
    expect(kinds()).toEqual(["session"]);
  });

  it("reopens a fan-out's compare tab, its lanes archived ones included (lanes.listArchived)", async () => {
    listed();
    bed.handlers["lanes.listArchived"] = () => ({
      lanes: [laneView({ id: "b-1a2b", projectRoot: "/w/api", fanoutId: FANOUT, state: "archived", archivedAt: 9, title: "Try caches" })],
      hasMore: false,
    });
    await show();
    expect(bed.called("lanes.listArchived")).toHaveLength(1);
    const row = document.querySelector('[data-recent-row="fanout"]') as HTMLElement;
    expect(text(row)).toContain("Fan-out");
    expect(text(row)).toContain("Archived");
    expect(row.querySelector("a")?.getAttribute("href")).toBe(`/compare/${FANOUT}`);
    await click(row.querySelector("a") as HTMLElement);
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "compare", id: FANOUT });
  });

  it("carries each row's project under All projects", async () => {
    listed(
      shellSession({ id: "a", projectId: "p1", cwd: "/w/api/one", updatedAt: 2 }),
      shellSession({ id: "b", projectId: "p2", cwd: "/w/web/two", updatedAt: 1 }),
    );
    await show(null);
    const chips = (index: number) =>
      [...(document.querySelectorAll("[data-recent-row]")[index]?.querySelectorAll('[data-slot="chip"]') ?? [])].map(
        (chip) => chip.textContent,
      );
    expect(chips(0)).toEqual(["Session", "api"]);
    expect(chips(1)).toEqual(["Session", "web"]);
  });

  it("shows loading until the shell stream has loaded, then says when there is nothing yet", async () => {
    await show();
    expect(text(document.body)).toContain("Loading");
    await act(async () => listed());
    expect(text(document.body)).toContain("Nothing yet. Launch something above.");
  });

  it("says the shell stream broke, with Retry", async () => {
    useShellStore.getState().fail("capacity");
    const container = await show();
    expect([...container.querySelectorAll('[role="alert"]')]).toHaveLength(1);
    expect(button(container, "Retry")).toBeDefined();
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/RecentWork.test.tsx`
Expected: FAIL — `RecentWork.tsx` does not exist.

- [ ] **Step 4: The hook, the component, the strings**

Create `apps/web/src/features/home/use-archived-lanes.ts`:

```ts
import type { LaneView } from "@pap/contracts";
import { useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

/**
 * The first page of archived lanes (`lanes.listArchived`), asked once when the home mounts: Recent work lists them and
 * groups their fan-outs (§3.4). The newest archives come first; older ones stay on the tree's shelf.
 */
export function useArchivedLanes(): readonly LaneView[] {
  const [lanes, setLanes] = useState<readonly LaneView[]>([]);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("lanes.listArchived", {})
      .then(
        (page) => {
          if (current && Array.isArray(page.lanes)) setLanes(page.lanes);
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, []);
  return lanes;
}
```

Append to `homeEn` in `apps/web/src/i18n/catalog/home.ts`:

```ts
  "home.recent.title": "Recent work",
  "home.recent.filter": "Show",
  "home.recent.filter.all": "All",
  "home.recent.filter.sessions": "Sessions",
  "home.recent.filter.lanes": "Lanes",
  "home.recent.filter.tasks": "Tasks",
  "home.recent.more": "Show more",
  "home.recent.empty": "Nothing yet. Launch something above.",
  "home.kind.session": "Session",
  "home.kind.lane": "Lane",
  "home.kind.fanout": "Fan-out",
  "home.kind.task": "Task",
  "home.state.lane.creating": "Creating",
  "home.state.lane.active": "Active",
  "home.state.lane.archiving": "Archiving",
  "home.state.lane.archived": "Archived",
  "home.state.lane.failed": "Failed",
  "home.state.fanout.active": "Open",
  "home.state.fanout.archived": "Archived",
  "home.state.task.queued": "Queued",
  "home.state.task.running": "Running",
  "home.state.task.limited": "Limited",
  "home.state.task.done": "Done",
  "home.state.task.failed": "Failed",
  "home.state.task.cancelled": "Cancelled",
  "home.state.task.interrupted": "Interrupted",
```

and to `homeFr`:

```ts
  "home.recent.title": "Travail récent",
  "home.recent.filter": "Afficher",
  "home.recent.filter.all": "Tout",
  "home.recent.filter.sessions": "Sessions",
  "home.recent.filter.lanes": "Lanes",
  "home.recent.filter.tasks": "Tâches",
  "home.recent.more": "Afficher plus",
  "home.recent.empty": "Rien pour l'instant. Lancez quelque chose ci-dessus.",
  "home.kind.session": "Session",
  "home.kind.lane": "Lane",
  "home.kind.fanout": "Fan-out",
  "home.kind.task": "Tâche",
  "home.state.lane.creating": "Création",
  "home.state.lane.active": "Active",
  "home.state.lane.archiving": "Archivage",
  "home.state.lane.archived": "Archivée",
  "home.state.lane.failed": "Échouée",
  "home.state.fanout.active": "Ouvert",
  "home.state.fanout.archived": "Archivé",
  "home.state.task.queued": "En attente",
  "home.state.task.running": "En cours",
  "home.state.task.limited": "Limitée",
  "home.state.task.done": "Terminée",
  "home.state.task.failed": "Échouée",
  "home.state.task.cancelled": "Annulée",
  "home.state.task.interrupted": "Interrompue",
```

In `apps/web/src/i18n/lazy-catalog.home.test.ts`, add `"features/home/RecentWork.tsx"` to `IN_CHUNK`.

Create `apps/web/src/features/home/RecentWork.tsx`:

```tsx
import "../../i18n/register-home.ts";
import type { ProjectSummary } from "@pap/contracts";
import { Button, Chip, cn, FOCUS_RING } from "@pap/ui";
import { useEffect, useId, useState } from "react";
import { formatAge } from "../../i18n/age.ts";
import { type Translate, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import type { HomeActions } from "./home-actions.ts";
import { useArchivedLanes } from "./use-archived-lanes.ts";
import {
  filterRows,
  RECENT_FILTERS,
  RECENT_PAGE,
  type RecentFilter,
  type RecentRow,
  recentRows,
} from "./recent-work.vm.ts";

const stateWord = (row: RecentRow, t: Translate): string => {
  switch (row.kind) {
    case "session":
      return t(`session.status.${row.state}`);
    case "lane":
      return t(`home.state.lane.${row.state}`);
    case "fanout":
      return t(`home.state.fanout.${row.state}`);
    case "task":
      return t(`home.state.task.${row.state}`);
  }
};

interface Props {
  readonly project: ProjectSummary | null;
  readonly actions: HomeActions;
}

/** §3.4: the project's sessions, lanes, fan-outs and tasks in one list, 20 at a time; a fan-out row reopens its compare. */
export function RecentWork({ project, actions }: Props) {
  const t = useT();
  const titleId = useId();
  const sessions = useShellStore((state) => state.view.sessions);
  const projects = useShellStore((state) => state.view.projects);
  const loaded = useShellStore((state) => state.view.loaded);
  const broken = useShellStore((state) => state.view.unreadable || state.view.failed !== null);
  const lanes = useLaneStore((state) => state.view.lanes);
  const fanouts = useLaneStore((state) => state.view.fanouts);
  const tasks = useTasksStore((state) => state.view.list);
  const archived = useArchivedLanes();
  const [filter, setFilter] = useState<RecentFilter>("all");
  const [shown, setShown] = useState(RECENT_PAGE);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const rows = filterRows(
    recentRows({ project, sessions, projects, lanes: [...lanes.values(), ...archived], fanouts, tasks, now }),
    filter,
  );

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-s2">
      <div className="flex flex-wrap items-center justify-between gap-s2">
        <h2 id={titleId} className="label-hud text-muted">
          {t("home.recent.title")}
        </h2>
        <div role="group" aria-label={t("home.recent.filter")} className="flex flex-wrap gap-s1">
          {RECENT_FILTERS.map((one) => (
            <Button
              key={one}
              size="sm"
              variant={filter === one ? "primary" : "ghost"}
              aria-pressed={filter === one}
              onClick={() => {
                setFilter(one);
                setShown(RECENT_PAGE);
              }}
            >
              {t(`home.recent.filter.${one}`)}
            </Button>
          ))}
        </div>
      </div>
      {broken ? (
        <div className="flex items-center gap-s2">
          <p role="alert" className="text-ui text-attn">
            {t("shell.tree.error")}
          </p>
          <Button variant="secondary" size="sm" onClick={() => getRuntime().subscriptions.resync("shell", "me")}>
            {t("shell.tree.retry")}
          </Button>
        </div>
      ) : !loaded ? (
        <p className="text-ui text-muted">{t("shell.tree.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-ui text-muted">{t("home.recent.empty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-s1">
            {rows.slice(0, shown).map((row) => {
              const projectName = row.projectId === null ? undefined : projects.get(row.projectId)?.name;
              return (
                <li key={row.key} data-recent-row={row.kind} className="flex items-center gap-s2">
                  <Chip tone="mut" label={t(`home.kind.${row.kind}`)} />
                  <a
                    href={actions.href(row.target)}
                    className={cn("min-w-0 flex-1 truncate text-fg underline", FOCUS_RING)}
                    onClick={(event) => {
                      event.preventDefault();
                      actions.open(row.target);
                    }}
                  >
                    {row.title}
                  </a>
                  <span className="text-ui text-muted">{stateWord(row, t)}</span>
                  {project === null && projectName !== undefined ? <Chip tone="mut" label={projectName} /> : null}
                  <span className="label-hud text-muted">{formatAge(now, row.at, t)}</span>
                </li>
              );
            })}
          </ul>
          {rows.length > shown ? (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setShown((count) => count + RECENT_PAGE)}>
                {t("home.recent.more")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home apps/web/src/i18n`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm knip`
Expected: clean.

```bash
git add apps/web/src/features/home apps/web/src/i18n/catalog/home.ts apps/web/src/i18n/lazy-catalog.home.test.ts
git commit -m "feat(home): Recent work merges sessions, lanes, fan-outs and tasks; a fan-out row reopens compare"
```

---
### Task 9: The other gaps — rail Tasks, shortcuts in the account menu, lane Compare link, the phone's minimum

Track 2. Spec §5, §9 ("the phone entries").

**Files:**
- Modify: `packages/ui/src/icons.ts`, `packages/ui/src/index.ts` (`IconTasks`)
- Modify: `apps/web/src/routes/shell/Rail.tsx`, `AppShell.test.tsx`
- Create: `apps/web/src/routes/shell/MobileListsMenu.tsx`
- Modify: `apps/web/src/routes/shell/MobileShell.tsx`
- Create: `apps/web/src/routes/shell/MobileShell.home.test.tsx`
- Modify: `apps/web/src/features/lanes/LaneBody.tsx`, `LaneHeader.tsx`
- Create: `apps/web/src/features/lanes/LaneScreen.compare.test.tsx`
- Modify: `apps/web/src/routes/shell/pane-renderers.tsx` (`lanePanes.openCompare`)
- Modify: `apps/web/src/i18n/catalog/shell.ts`, `apps/web/src/i18n/catalog/lanes.ts`

**Interfaces:**
- Consumes: commands `tasks.open` target `{ kind: "tasks" }`, `shortcuts.help`, `session.new`; `ShellContext` (`username`, `onSignedOut`); `signOut`.
- Produces:
  - `IconTasks` (lucide `ListTodo`) from `@pap/ui`.
  - `LanePanes.openCompare?(fanoutId: string): void`; `HeaderActions.onOpenCompare: (() => void) | null`.
  - Command `mobile.inbox.open` (registered by `MobileShell`, not in `COMMANDS`, like `mobile.lists.open`): shows the phone's Inbox section. Task 10's `homeActions.openInbox` uses it.
  - `MobileListsMenu()`.
  - Keys `shell.rail.tasks`, `shell.rail.shortcuts`, `shell.mobile.more` (eager), `lanes.action.compare` (lazy lanes catalog).

- [ ] **Step 1: Failing tests**

In `apps/web/src/routes/shell/AppShell.test.tsx`, the account menu gains "Keyboard shortcuts" before "Sign out": change `expect(rows).toEqual(["ana", "Sign out"]);` to `expect(rows).toEqual(["ana", "Keyboard shortcuts", "Sign out"]);`, press `ArrowDown` twice (not once) before `Enter`, and change the next test's `["Sign out"]` to `["Keyboard shortcuts", "Sign out"]`. Then append to the same `describe`:

```tsx
  it("the rail's Tasks button opens the Tasks board (§5)", async () => {
    const page = await withMenu("/");
    await click(page.container.querySelector('[aria-label="Tasks"]') as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/tasks");
    await page.unmount();
  });

  it("the account menu opens the keyboard shortcuts (§5)", async () => {
    const page = await withMenu("/");
    await click(page.container.querySelector('[aria-label="Account"]') as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), { timeout: 2000 });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (row) => row.textContent === "Keyboard shortcuts",
    );
    await click(item as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector("[data-command]")).not.toBeNull(), { timeout: 2000 });
    await page.unmount();
  });
```

Create `apps/web/src/routes/shell/MobileShell.home.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { runCommand } from "../../lib/command-registry.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const auth = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-api.ts")>()),
  logout: auth.logout,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([]));
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  auth.logout.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  vi.unstubAllGlobals();
});

const menuRows = () => [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
async function openListsMenu(container: HTMLElement) {
  await click(button(container, "Lists"));
  await click(button(container, "Settings and account"));
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), { timeout: 2000 });
}

describe("the phone's minimum entries (§5)", () => {
  it("the logo and + go to the home", async () => {
    const page = await renderShell("/settings/appearance", { phone: true, chunks: ["menu"] });
    await settle();
    const logo = page.container.querySelector('header a[href="/"]') as HTMLAnchorElement;
    expect(logo.getAttribute("aria-label")).toBe("pap");
    await click(logo);
    await settle();
    expect(page.router.state.location.pathname).toBe("/");
    await act(async () => page.router.navigate({ to: "/settings/appearance" }));
    await settle();
    await click(button(page.container, "New session"));
    await settle();
    expect(page.router.state.location.pathname).toBe("/");
    await page.unmount();
  });

  it("the Lists tab's menu reaches Settings and the account without the palette", async () => {
    const onSignedOut = vi.fn();
    const page = await renderShell("/", { phone: true, onSignedOut, chunks: ["menu"] });
    await settle();
    await openListsMenu(page.container);
    expect(menuRows()).toEqual(["Settings", "ana", "Sign out"]);
    await click([...document.querySelectorAll('[role="menuitem"]')].find((row) => row.textContent === "Settings") as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/settings/appearance");
    await openListsMenu(page.container);
    await click([...document.querySelectorAll('[role="menuitem"]')].find((row) => row.textContent === "Sign out") as HTMLElement);
    await settle();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("mobile.inbox.open shows the Inbox section", async () => {
    const page = await renderShell("/", { phone: true });
    await settle();
    await act(async () => void runCommand("mobile.inbox.open"));
    expect(button(page.container, "Inbox").getAttribute("aria-current")).toBe("page");
    await page.unmount();
  });
});
```

Create `apps/web/src/features/lanes/LaneScreen.compare.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, click, hasButton, settle } from "../../testing/dom.ts";
import { load, phone, resetLaneScreenBed, show } from "../../testing/lane-screen-bed.tsx";
import { current } from "./lanes-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const FANOUT = "0123456789abcdef";
beforeEach(resetLaneScreenBed);
afterEach(() => vi.unstubAllGlobals());

describe("lane header: the fan-out's compare (§5)", () => {
  it("links a fan-out's lane to its compare tab", async () => {
    load({ fanoutId: FANOUT, fanoutSlot: 0 });
    const openCompare = vi.fn();
    const page = await show({ openCompare });
    await click(button(page.container, "Compare"));
    expect(openCompare).toHaveBeenCalledExactlyOnceWith(FANOUT);
  });

  it("offers no Compare for a lane outside a fan-out", async () => {
    load();
    const page = await show({ openCompare: vi.fn() });
    expect(hasButton(page.container, "Compare")).toBe(false);
  });

  it("puts Compare in the phone's sheet", async () => {
    phone(true);
    load({ fanoutId: FANOUT, fanoutSlot: 1 });
    const openCompare = vi.fn();
    const page = await show({ openCompare });
    await click(button(page.container, "Lane actions"));
    await settle();
    await click(button(document.body, "Compare"));
    expect(openCompare).toHaveBeenCalledExactlyOnceWith(FANOUT);
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/routes/shell/AppShell.test.tsx apps/web/src/routes/shell/MobileShell.home.test.tsx apps/web/src/features/lanes/LaneScreen.compare.test.tsx`
Expected: FAIL — no Tasks button, no shortcuts row, no logo link, no Lists menu, no Compare.

- [ ] **Step 2: The icon and the strings**

`packages/ui/src/icons.ts`: add `ListTodo as IconTasks,` to the `lucide-react` export list, after `List as IconLists` (the list is ordered by lucide name). `packages/ui/src/index.ts`: add `IconTasks,` to the icons export after `IconSplit`. Confirm the name: `node -e "import('lucide-react').then((m) => console.log(Boolean(m.ListTodo)))"` run in `packages/ui` prints `true`.

`apps/web/src/i18n/catalog/shell.ts`, English after `"shell.rail.signOut"`:

```ts
  "shell.rail.tasks": "Tasks",
  "shell.rail.shortcuts": "Keyboard shortcuts",
```

and after `"shell.mobile.tabs"`: `"shell.mobile.more": "Settings and account",`. French, same places:

```ts
  "shell.rail.tasks": "Tâches",
  "shell.rail.shortcuts": "Raccourcis clavier",
```

and `"shell.mobile.more": "Réglages et compte",`.

`apps/web/src/i18n/catalog/lanes.ts`: after `"lanes.action.archive"`, English `"lanes.action.compare": "Compare",`, French `"lanes.action.compare": "Comparer",`.

- [ ] **Step 3: Rail**

`apps/web/src/routes/shell/Rail.tsx`: import `IconTasks` from `@pap/ui` and `runCommand` from `../../features/commands/index.ts`; after `<div className="flex-1" />` add

```tsx
      <IconButton
        icon={IconTasks}
        label={t("shell.rail.tasks")}
        onClick={() => go(navigate, pathOfItem({ kind: "tasks" }))}
      />
```

and give the account menu a row before sign-out:

```tsx
          { id: "shortcuts", label: t("shell.rail.shortcuts"), onSelect: () => void runCommand("shortcuts.help") },
```

Update the component comment: "Logo, Tasks, Settings and the account menu (with the keyboard shortcuts, §5)."

- [ ] **Step 4: The phone**

Create `apps/web/src/routes/shell/MobileListsMenu.tsx`:

```tsx
import { IconButton, IconMore } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { useNavigate } from "@tanstack/react-router";
import { useContext } from "react";
import { pathOfItem } from "../../features/workspace/index.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { ShellContext } from "./shell-context.ts";
import { signOut } from "./sign-out.ts";
import { go } from "./tab-actions.ts";

/** The Lists tab's header menu (§5): Settings and the account on a phone, without the palette (no rail there). */
export function MobileListsMenu() {
  const t = useT();
  const lazyText = useLazyFailureText();
  const navigate = useNavigate();
  const shell = useContext(ShellContext);
  const items: MenuItem[] = [
    {
      id: "settings",
      label: t("shell.rail.settings"),
      onSelect: () => go(navigate, pathOfItem({ kind: "settings", section: "appearance" })),
    },
    ...(shell?.username ? [{ id: "user", label: shell.username, disabled: true, onSelect: () => {} }] : []),
    ...(shell ? [{ id: "sign-out", label: t("shell.rail.signOut"), onSelect: () => signOut(shell.onSignedOut) }] : []),
  ];
  return (
    <div className="flex items-center justify-end border-b border-border px-s2 py-s1">
      <LazyMenu
        label={t("shell.mobile.more")}
        closeLabel={t("ui.close")}
        text={lazyText}
        items={items}
        trigger={(ask) => <IconButton icon={IconMore} label={t("shell.mobile.more")} onClick={ask} />}
      />
    </div>
  );
}
```

`apps/web/src/routes/shell/MobileShell.tsx`:
- imports: `IconPlus` from `@pap/ui`; `Link` from `@tanstack/react-router` (beside `useRouterState`); `MobileListsMenu` from `./MobileListsMenu.tsx`;
- after `useCommand("mobile.lists.open", () => setSection("lists"));` add

```ts
  // The home's Inbox entry and status line on a phone: the Inbox section, not the desktop drawer.
  useCommand("mobile.inbox.open", () => setSection("inbox"));
```

- in the header, replace `<Mark size={20} />` with

```tsx
        <Link to="/" aria-label={t("app.name")} className="focus-ring rounded-sm">
          <Mark size={20} />
        </Link>
```

  and add, before the search `IconButton`:

```tsx
        <IconButton icon={IconPlus} label={t("shell.tab.home")} onClick={() => void runCommand("session.new")} />
```

- the Lists section renders the menu above the tree:

```tsx
        ) : section === "lists" ? (
          <>
            <MobileListsMenu />
            <LazyPanel
              text={lazyText}
              load={loadTree}
              open={section === "lists"}
              props={{
                onPick: () => setSection("work"),
                onNewSession: () => setSection("work"),
                chord,
                loadArchivedLanes,
              }}
              onFailed={() => setSection("work")}
            />
          </>
        ) : section === "inbox" ? (
```

- [ ] **Step 5: The lane Compare link**

`apps/web/src/features/lanes/LaneBody.tsx`: add to `LanePanes`

```ts
  /** Opens the compare tab of the lane's fan-out (§5): the shell decides how a tab opens. */
  openCompare?(fanoutId: string): void;
```

and before the `return`, next to `const title = …`:

```ts
  const fanoutId = lane.fanoutId;
  const openCompare = panes.openCompare;
```

then add to the `actions` object passed to `LaneHeader`:

```ts
          onOpenCompare: fanoutId !== null && openCompare !== undefined ? () => openCompare(fanoutId) : null,
```

`apps/web/src/features/lanes/LaneHeader.tsx`: add to `HeaderActions`

```ts
  /** The fan-out's compare tab (§5); null for a lane outside a fan-out. */
  readonly onOpenCompare: (() => void) | null;
```

prepend to the phone menu's `items`:

```ts
    ...(actions.onOpenCompare !== null
      ? [{ id: "compare", label: t("lanes.action.compare"), onSelect: actions.onOpenCompare }]
      : []),
```

and in the desktop action span, before the Setup log button:

```tsx
          {actions.onOpenCompare !== null ? (
            <Button size="sm" onClick={actions.onOpenCompare}>
              {t("lanes.action.compare")}
            </Button>
          ) : null}
```

`apps/web/src/routes/shell/pane-renderers.tsx`: add to `lanePanes`

```tsx
  openCompare: (fanoutId: string) => useWorkspaceStore.getState().open({ kind: "compare", id: fanoutId }),
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run --project unit apps/web/src/routes/shell apps/web/src/features/lanes packages/ui`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm knip && pnpm exec vitest run --project unit apps/web/src/i18n`
Expected: clean.

```bash
git add packages/ui/src/icons.ts packages/ui/src/index.ts apps/web/src/routes/shell apps/web/src/features/lanes \
  apps/web/src/i18n/catalog/shell.ts apps/web/src/i18n/catalog/lanes.ts
git commit -m "feat(shell): Tasks in the rail, shortcuts in the account menu, Compare in a fan-out lane, the phone's minimum"
```

---

## JOIN

Run the JOIN described under "Parallel tracks and the JOIN" before Task 10: merge `feat/project-home-web` into `feat/project-home`, reconcile the four named files, run every gate, record the initial bundle number, commit `chore: join the project home tracks`.

---
### Task 10: The project home composer replaces the session list

Track J (after the JOIN). Spec §3 (route), §3.1, §3.5, §7, §9 ("each mode's Launch", "an empty Launch per mode", "the remembered mode", "a disabled action showing its reason", "'All projects' opening the picker"), §10 (the old home goes, its tests move). Rulings PH6, PH12, PH13, PH14. Review Focus 1 and 3.

**Files:**
- Create: `apps/web/src/features/home/home-mode.ts`, `home-mode.test.ts`
- Create: `apps/web/src/features/home/project-facts.ts`, `project-facts.test.ts`
- Create: `apps/web/src/features/home/use-launch.ts`
- Create: `apps/web/src/features/home/ModeChips.tsx`
- Create: `apps/web/src/features/home/ProjectPicker.tsx`
- Create: `apps/web/src/features/home/ProjectHome.tsx`
- Create: `apps/web/src/features/home/ProjectHome.test.tsx`, `ProjectHome.modes.test.tsx`, `ProjectHome.picker.test.tsx`
- Create: `apps/web/src/testing/home-bed.tsx`
- Create: `apps/web/src/i18n/catalog/launch.ts`; modify `apps/web/src/i18n/en.ts`, `fr.ts`, `catalog/shell.ts`, `catalog/home.ts`, `i18n.test.tsx`, `catalog-keys.test.ts`, `lazy-catalog.home.test.ts`
- Create: `apps/web/src/routes/shell/home-actions.ts`, `home-actions.test.ts`
- Create: `apps/web/src/routes/shell/HomePane.tsx`, `HomePane.test.tsx`
- Modify: `apps/web/src/routes/shell/pane-renderers.tsx` (the `home` renderer)
- Delete: `apps/web/src/features/sessions/SessionListScreen.tsx`, `SessionListScreen.test.tsx`, `SessionListScreen.preset.test.tsx`
- Modify: every `apps/web/src/routes/{shell,settings}/*.test.tsx` that mocks `SessionListScreen` (one sed, Step 9)

**Interfaces:**
- Consumes: `HomeActions`, `HomeShortcuts`, `HomeChord` (Task 7); `laneLaunch`, `triggerLaunch` (Task 5); `useTriggerPrefill`, `useNewLaneRequest` (Task 5); `usePaletteRequest` (Task 6); `useAddProjectRequest` (Task 3); `listedProjects`, `useEffectiveProject`, `useCurrentProject` (Task 2); `mobile.inbox.open` (Task 9); `useComposerPrefill`; `lanes.preview`; `sessions.create`, `sessions.prompt`; `useTasksFeed` (`routes/shell/use-tasks-feed.ts`); `lastPreset`, `rememberPreset`, `PresetPicker` (`features/sessions`).
- Produces:
  - `HOME_MODES = ["session", "lane", "fanout", "trigger"] as const`, `type HomeMode`, `MODE_KEY = "pap.home.mode.v1"`, `readMode(): HomeMode`, `rememberMode(mode: HomeMode): void`, `isLaunchKey(event, phone: boolean): boolean` (`home-mode.ts`).
  - `useGitFact(root: string | null): boolean | null`, `modeReasons(facts: { git: boolean | null; counts: TasksCounts | null }): Partial<Record<HomeMode, MessageKey>>` (`project-facts.ts`).
  - `startSession(cwd: string, text: string, preset: ToolPreset): Promise<string>`, `useLaunch(actions: HomeActions, preset: ToolPreset): { launch(mode: HomeMode, project: ProjectSummary, text: string): void; busy: boolean; error: string | null }` (`use-launch.ts`).
  - `ModeChips({ mode, reasons, laneChord, onMode })`; `ProjectPicker` (default export: `{ projects; onPick(id); onAdd(); onClose() }`); `ProjectHome({ actions, shortcuts, preset, presetField(disabled: boolean): ReactNode })`.
  - `homeActions(navigate: Navigate): HomeActions` (`routes/shell/home-actions.ts`); `HomePane()` (`routes/shell/HomePane.tsx`), the `home` pane.
  - Eager keys `launch.*`; lazy keys `home.picker.*`.

- [ ] **Step 1: Failing unit tests for modes and reasons**

Create `apps/web/src/features/home/home-mode.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLaunchKey, MODE_KEY, readMode, rememberMode } from "./home-mode.ts";

const key = (init: { key: string; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number }) => ({
  key: init.key,
  shiftKey: init.shiftKey ?? false,
  altKey: init.altKey ?? false,
  nativeEvent: { isComposing: init.isComposing ?? false, ...(init.keyCode === undefined ? {} : { keyCode: init.keyCode }) },
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("the home's mode, per device (PH14)", () => {
  it("starts on Session, then reads back the last mode chosen; anything else stored reads as Session", () => {
    expect(readMode()).toBe("session");
    rememberMode("fanout");
    expect(localStorage.getItem(MODE_KEY)).toBe("fanout");
    expect(readMode()).toBe("fanout");
    localStorage.setItem(MODE_KEY, "agent");
    expect(readMode()).toBe("session");
  });

  it("goes on when storage refuses, for the page only", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    expect(() => rememberMode("lane")).not.toThrow();
    expect(readMode()).toBe("session");
  });
});

describe("isLaunchKey (§3.1, PH6, Review Focus 3)", () => {
  it("launches on Enter, Ctrl+Enter too; Shift+Enter and Alt+Enter are a new line", () => {
    expect(isLaunchKey(key({ key: "Enter" }), false)).toBe(true);
    expect(isLaunchKey(key({ key: "Enter", shiftKey: true }), false)).toBe(false);
    expect(isLaunchKey(key({ key: "Enter", altKey: true }), false)).toBe(false);
    expect(isLaunchKey(key({ key: "a" }), false)).toBe(false);
  });

  it("never launches on an input method's Enter, nor on a phone's Enter", () => {
    expect(isLaunchKey(key({ key: "Enter", isComposing: true }), false)).toBe(false);
    expect(isLaunchKey(key({ key: "Enter", keyCode: 229 }), false)).toBe(false);
    expect(isLaunchKey(key({ key: "Enter" }), true)).toBe(false);
  });
});
```

Create `apps/web/src/features/home/project-facts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { modeReasons } from "./project-facts.ts";

const counts = (patch: { paused?: boolean; budgetUsd?: number | null } = {}) => ({
  paused: patch.paused ?? false,
  slots: 2,
  running: 0,
  queued: 0,
  quietHours: false,
  todayUsd: 0,
  budgetUsd: patch.budgetUsd ?? null,
});

describe("modeReasons (§3.2 ask, don't hide; PH12)", () => {
  it("disables Lane and Fan-out only once the folder is known not to be a repository", () => {
    expect(modeReasons({ git: null, counts: null })).toEqual({});
    expect(modeReasons({ git: true, counts: counts() })).toEqual({});
    expect(modeReasons({ git: false, counts: null })).toEqual({
      lane: "launch.reason.notGit",
      fanout: "launch.reason.notGit",
    });
  });

  it("disables Trigger while automation is paused, or with a $0 daily budget", () => {
    expect(modeReasons({ git: true, counts: counts({ paused: true }) })).toEqual({ trigger: "launch.reason.paused" });
    expect(modeReasons({ git: true, counts: counts({ budgetUsd: 0 }) })).toEqual({ trigger: "launch.reason.noBudget" });
    expect(modeReasons({ git: true, counts: counts({ budgetUsd: 5 }) })).toEqual({});
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/home-mode.test.ts apps/web/src/features/home/project-facts.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 2: Modes, facts, launch**

Create `apps/web/src/features/home/home-mode.ts`:

```ts
import { cancelsComposition } from "@pap/ui";
import { deviceStorage } from "../../stores/drafts.ts";

export const HOME_MODES = ["session", "lane", "fanout", "trigger"] as const;
export type HomeMode = (typeof HOME_MODES)[number];

/** The last mode chosen on this device (§3.1); not per account. */
export const MODE_KEY = "pap.home.mode.v1";

/** The last mode chosen here; Session when none was, when storage holds anything else, or when it refuses. */
export function readMode(): HomeMode {
  try {
    const raw = deviceStorage()?.getItem(MODE_KEY);
    return (HOME_MODES as readonly unknown[]).includes(raw) ? (raw as HomeMode) : "session";
  } catch {
    return "session";
  }
}

/** Remembers the choice for this device; storage that refuses leaves it holding for this page only. */
export function rememberMode(mode: HomeMode): void {
  try {
    deviceStorage()?.setItem(MODE_KEY, mode);
  } catch {
    // A convenience only: the composer keeps the mode in memory.
  }
}

interface LaunchKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean; readonly keyCode?: number };
}

/**
 * §3.1 and PH6: Enter launches (Ctrl/⌘+Enter too), Shift+Enter adds a line. An input method's Enter never launches,
 * and on a phone, whose keyboard has no Shift, Enter is a new line and the button launches.
 */
export function isLaunchKey(event: LaunchKeyEvent, phone: boolean): boolean {
  return (
    event.key === "Enter" && !event.shiftKey && !event.altKey && !phone && !cancelsComposition(event.nativeEvent)
  );
}
```

Create `apps/web/src/features/home/project-facts.ts`:

```ts
import type { TasksCounts } from "@pap/contracts";
import { useEffect, useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { HomeMode } from "./home-mode.ts";

/**
 * Whether the project's folder is a repository's main checkout (`lanes.preview`), asked once per root. Null until it
 * answers, and when it cannot (PH12: an unknown fact never disables).
 */
export function useGitFact(root: string | null): boolean | null {
  const [fact, setFact] = useState<{ root: string; git: boolean } | null>(null);
  useEffect(() => {
    if (root === null) return undefined;
    let current = true;
    getRuntime()
      .rpc.call("lanes.preview", { projectRoot: root })
      .then(
        (preview) => {
          if (current) setFact({ root, git: preview.repo });
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [root]);
  return fact !== null && fact.root === root ? fact.git : null;
}

/** §3.2 "Ask, don't hide": why a mode cannot run in this project. A mode with no entry can run. */
export function modeReasons(facts: {
  readonly git: boolean | null;
  readonly counts: TasksCounts | null;
}): Partial<Record<HomeMode, MessageKey>> {
  const lanes: MessageKey | null = facts.git === false ? "launch.reason.notGit" : null;
  const trigger: MessageKey | null =
    facts.counts?.paused === true
      ? "launch.reason.paused"
      : facts.counts?.budgetUsd === 0
        ? "launch.reason.noBudget"
        : null;
  return {
    ...(lanes === null ? {} : { lane: lanes, fanout: lanes }),
    ...(trigger === null ? {} : { trigger }),
  };
}
```

Create `apps/web/src/features/home/use-launch.ts`:

```ts
import type { ProjectSummary, ToolPreset } from "@pap/contracts";
import { useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import type { HomeActions } from "./home-actions.ts";
import type { HomeMode } from "./home-mode.ts";
import { laneLaunch, triggerLaunch } from "./launch-text.ts";

/**
 * Session (§3.1): `sessions.create` in the folder, then the text as the first message. A refused or unknown prompt keeps
 * the text in the new session's composer, so it is never lost; sent or not, that session's transcript says (Review Focus 1).
 */
export async function startSession(cwd: string, text: string, preset: ToolPreset): Promise<string> {
  const { rpc } = getRuntime();
  const { sessionId } = await rpc.call("sessions.create", { cwd, preset });
  const message = text.trim();
  if (message !== "") {
    try {
      await rpc.call("sessions.prompt", { sessionId, text: message });
    } catch {
      useComposerPrefill.getState().push(sessionId, message);
    }
  }
  return sessionId;
}

/** What Launch does per mode (§3.1). Lane, Fan-out and Trigger hand their prefill to the shell; Session runs here. */
export function useLaunch(actions: HomeActions, preset: ToolPreset) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launch = (mode: HomeMode, project: ProjectSummary, text: string): void => {
    setError(null);
    if (mode === "trigger") {
      actions.newTrigger(project.id, triggerLaunch(text));
      return;
    }
    if (mode === "lane" || mode === "fanout") {
      if (!actions.newLane(laneLaunch(text, project.root, mode === "fanout"))) setError(t("launch.error.noLaneHost"));
      return;
    }
    setBusy(true);
    // Promise chains, not try/finally: the React Compiler bails out on a finalizer. A timeout is never re-sent (R105).
    startSession(project.root, text, preset).then(
      (sessionId) => {
        setBusy(false);
        actions.open({ kind: "session", id: sessionId });
      },
      (failure: unknown) => {
        setBusy(false);
        const said = t(errorKey(failure instanceof RpcError ? failure.code : "internal"));
        // A capacity refusal from a daemon that counted adds "n / n workers", as the old home did.
        const workers = failure instanceof RpcError ? failure.workers : undefined;
        setError(workers ? `${said} ${t("error.capacityWorkers", { used: workers.used, max: workers.max })}` : said);
      },
    );
  };
  return { launch, busy, error };
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/home-mode.test.ts apps/web/src/features/home/project-facts.test.ts`
Expected: PASS. (Vitest does not type-check: the `launch.*` keys these files name arrive in Step 3, before any `pnpm typecheck`.)

- [ ] **Step 3: The eager `launch` catalog; the old home's keys go**

Create `apps/web/src/i18n/catalog/launch.ts`:

```ts
/** The project home's composer (decision 85): eager, it is the first paint at "/". Its body's words are lazy (`home.ts`). */
export const launchEn = {
  "launch.modes": "Launch mode",
  "launch.mode.session": "Session",
  "launch.mode.lane": "Lane",
  "launch.mode.fanout": "Fan-out",
  "launch.mode.trigger": "Trigger",
  "launch.hint.lane": "New lane",
  "launch.field": "What to do",
  "launch.placeholder": "What do you want to do in {project}?",
  "launch.placeholderAll": "What do you want to do? Launch asks which project.",
  "launch.go": "Launch",
  "launch.go.session": "Launch a session",
  "launch.go.lane": "Launch a lane",
  "launch.go.fanout": "Launch a fan-out",
  "launch.go.trigger": "Launch a trigger",
  "launch.options": "Session options",
  "launch.reason.notGit": "Lane and Fan-out: not a git repository.",
  "launch.reason.paused": "Trigger: automation is paused.",
  "launch.reason.noBudget": "Trigger: the daily budget is $0, so no trigger can run.",
  "launch.error.noLaneHost": "pap could not open the New lane dialog. Reload the page.",
} as const;

export const launchFr: { readonly [K in keyof typeof launchEn]: string } = {
  "launch.modes": "Mode de lancement",
  "launch.mode.session": "Session",
  "launch.mode.lane": "Lane",
  "launch.mode.fanout": "Fan-out",
  "launch.mode.trigger": "Déclencheur",
  "launch.hint.lane": "Nouvelle lane",
  "launch.field": "À faire",
  "launch.placeholder": "Que voulez-vous faire dans {project} ?",
  "launch.placeholderAll": "Que voulez-vous faire ? Lancer demande quel projet.",
  "launch.go": "Lancer",
  "launch.go.session": "Lancer une session",
  "launch.go.lane": "Lancer une lane",
  "launch.go.fanout": "Lancer un fan-out",
  "launch.go.trigger": "Lancer un déclencheur",
  "launch.options": "Options de la session",
  "launch.reason.notGit": "Lane et Fan-out : pas un dépôt git.",
  "launch.reason.paused": "Déclencheur : l'automatisation est en pause.",
  "launch.reason.noBudget": "Déclencheur : le budget quotidien est de 0 $, aucun déclencheur ne peut tourner.",
  "launch.error.noLaneHost": "pap n'a pas pu ouvrir la fenêtre Nouvelle lane. Rechargez la page.",
};
```

- `apps/web/src/i18n/en.ts`: `import { launchEn } from "./catalog/launch.ts";`, add `...launchEn,` after `...commandsEn,`, and delete the keys `sessions.title`, `sessions.cwd`, `sessions.cwdHint`, `sessions.create`, `sessions.empty`.
- `apps/web/src/i18n/fr.ts`: same with `launchFr`, same five keys deleted.
- `apps/web/src/i18n/catalog/shell.ts`: delete `sessions.recent` and `sessions.all` from both objects.
- `apps/web/src/i18n/i18n.test.tsx`: add `"launch.mode.session"`, `"launch.mode.lane"`, `"launch.mode.fanout"` to `IDENTICAL_IN_FR` (the same word in French, like `shell.tab.lane`).
- `apps/web/src/i18n/catalog-keys.test.ts`: import `{ launchEn, launchFr } from "./catalog/launch.ts"` and add `launch: Object.keys(launchEn),` / `launch: Object.keys(launchFr),` to the lists.
- `apps/web/src/i18n/catalog/home.ts`: append to `homeEn`

```ts
  "home.picker.label": "Launch in which project?",
  "home.picker.add": "Add project…",
  "home.picker.cancel": "Cancel",
```

  and to `homeFr`

```ts
  "home.picker.label": "Lancer dans quel projet ?",
  "home.picker.add": "Ajouter un projet…",
  "home.picker.cancel": "Annuler",
```

- `apps/web/src/i18n/lazy-catalog.home.test.ts`: add `"features/home/ProjectPicker.tsx"` to `IN_CHUNK`.

Run: `pnpm exec vitest run --project unit apps/web/src/i18n`
Expected: PASS once `rtk proxy grep -rn '"sessions\.\(title\|cwd\|cwdHint\|create\|empty\|recent\|all\)"' apps/web/src --include='*.ts' --include='*.tsx'` names only `SessionListScreen.tsx` and its two tests, which Step 9 deletes.

- [ ] **Step 4: The test bed and the failing composer tests**

Create `apps/web/src/testing/home-bed.tsx`:

```tsx
import type { ToolPreset } from "@pap/contracts";
import { ProjectHome } from "../features/home/ProjectHome.tsx";
import { useCurrentProject } from "../stores/current-project.ts";
import { useShellStore } from "../stores/shell-store.ts";
import { useTasksStore } from "../stores/tasks-store.ts";
import { mount, settle } from "./dom.ts";
import { fakeHomeActions, SHORTCUTS } from "./home-actions.ts";
import { shellProject, shellSnapshot } from "./shell-snapshot.ts";

export const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
export const web = shellProject({ id: "p2", name: "web", root: "/w/web", sessions: 1 });

/** Two projects in the shell store, `projectId` in the switcher (null: All projects), no tasks, nothing stored. */
export function resetHome(projectId: string | null = "p1"): void {
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [api, web] }));
  useCurrentProject.setState({ projectId, storageRefused: false, startedHere: 0 });
  useTasksStore.getState().reset();
}

export async function showHome(actions = fakeHomeActions(), preset: ToolPreset = "configured") {
  const page = await mount(
    <ProjectHome
      actions={actions}
      shortcuts={SHORTCUTS}
      preset={preset}
      presetField={(disabled) => <p data-preset-field={String(disabled)}>preset field</p>}
    />,
  );
  await settle();
  return { page, actions };
}

export const composer = () => document.querySelector('textarea[name="launch"]') as HTMLTextAreaElement;
export const chip = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) => node.textContent === label) as HTMLElement;
```

Create `apps/web/src/features/home/ProjectHome.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { alerts, button, click, settle, typeInto } from "../../testing/dom.ts";
import { composer, resetHome, showHome } from "../../testing/home-bed.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const runtime = (state: "open" | "waiting" = "open") => {
  bed = fakeRuntime(state);
  current.runtime = bed.runtime;
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  bed.handlers["sessions.create"] = () => ({ sessionId: "new-1" });
  bed.handlers["sessions.prompt"] = () => ({ disposition: "started" });
};
beforeEach(() => {
  runtime();
  useComposerPrefill.setState({ items: {} });
  resetHome();
});

describe("ProjectHome: the composer and a Session launch (§3.1)", () => {
  it("comes first: the composer has the focus, and the page names the project", async () => {
    const { page } = await showHome();
    expect(document.activeElement).toBe(composer());
    expect(composer().getAttribute("placeholder")).toBe("What do you want to do in api?");
    expect(page.container.querySelector("h1")?.textContent).toBe("api");
  });

  it("creates the session in the project's root with the preset, sends the text first, and opens it", async () => {
    const { page, actions } = await showHome(undefined, "read-only");
    await typeInto(composer(), "  Fix the login  ");
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/w/api", preset: "read-only" });
    expect(bed.called("sessions.prompt")[0]?.params).toEqual({ sessionId: "new-1", text: "Fix the login" });
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "session", id: "new-1" });
  });

  it("opens an empty session for an empty launch, as the old home did", async () => {
    const { page, actions } = await showHome();
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(bed.called("sessions.create")).toHaveLength(1);
    expect(bed.called("sessions.prompt")).toEqual([]);
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "session", id: "new-1" });
  });

  it.each(["prompt_rejected", "timeout"] as const)(
    "keeps the text in the new session's composer when the first message does not go (%s, Review Focus 1)",
    async (code) => {
      bed.handlers["sessions.prompt"] = () => {
        throw new RpcError(code);
      };
      const { page, actions } = await showHome();
      await typeInto(composer(), "Fix the login");
      await click(button(page.container, "Launch a session"));
      await settle();
      expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "session", id: "new-1" });
      expect(useComposerPrefill.getState().take("new-1")).toBe("Fix the login");
    },
  );

  it("shows the server's refusal of the folder and stays", async () => {
    bed.handlers["sessions.create"] = () => {
      throw new RpcError("invalid_cwd");
    };
    const { page, actions } = await showHome();
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(alerts(page.container)).toEqual([
      "The working directory must be an absolute path to an existing folder.",
    ]);
    expect(actions.open).not.toHaveBeenCalled();
  });

  it("says a create whose outcome is unknown may have gone through, and does not send it again (R105)", async () => {
    bed.handlers["sessions.create"] = () => {
      throw new RpcError("timeout");
    };
    const { page } = await showHome();
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(alerts(page.container)[0]).toContain("may still have gone through");
    expect(bed.called("sessions.create")).toHaveLength(1);
  });

  it("cannot launch while the connection is not open", async () => {
    runtime("waiting");
    const { page } = await showHome();
    expect(button(page.container, "Launch a session").disabled).toBe(true);
  });

  it("shows the tool preset under Session options, and only in Session mode", async () => {
    const { page } = await showHome();
    expect(document.querySelector("[data-preset-field]")).toBeNull();
    await click(button(page.container, "Session options"));
    expect(document.querySelector("[data-preset-field]")?.getAttribute("data-preset-field")).toBe("false");
  });

  it("New session here is an explicit action: Session mode, the composer focused", async () => {
    localStorage.setItem("pap.home.mode.v1", "trigger");
    const { page } = await showHome();
    button(page.container, "Launch a trigger").focus();
    await act(async () => useCurrentProject.getState().startHere("p1"));
    expect(button(page.container, "Launch a session")).toBeDefined();
    expect(document.activeElement).toBe(composer());
  });
});
```

Create `apps/web/src/features/home/ProjectHome.modes.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, press, settle, typeInto } from "../../testing/dom.ts";
import { tasksSnapshot } from "../../testing/home-fixtures.ts";
import { chip, composer, resetHome, showHome } from "../../testing/home-bed.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
// The tooltip loads Radix on hover: the hint it would show is read from the props instead.
vi.mock("@pap/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pap/ui")>()),
  Tooltip: (props: { label: string; shortcut?: readonly string[]; shortcutJoiner?: string; children: ReactElement }) =>
    createElement(
      "span",
      { "data-tip": `${props.label} ${(props.shortcut ?? []).join(props.shortcutJoiner ?? "")}` },
      props.children,
    ),
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  resetHome();
});
afterEach(() => vi.unstubAllGlobals());

const reasonOf = (node: HTMLElement) => document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent;

describe("ProjectHome: the modes (§3.1, §7)", () => {
  it("are a radiogroup moved by arrow keys, and the last one chosen is remembered for this device", async () => {
    const first = await showHome();
    const radios = () => [...document.querySelectorAll('[role="radio"]')].map((node) => [node.textContent, node.getAttribute("aria-checked")]);
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Launch mode");
    expect(radios()).toEqual([
      ["Session", "true"],
      ["Lane", "false"],
      ["Fan-out", "false"],
      ["Trigger", "false"],
    ]);
    await press(chip("Session"), { key: "ArrowRight" });
    expect(chip("Lane").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(chip("Lane"));
    await press(chip("Lane"), { key: "End" });
    expect(chip("Trigger").getAttribute("aria-checked")).toBe("true");
    await press(chip("Trigger"), { key: "ArrowRight" });
    expect(chip("Session").getAttribute("aria-checked")).toBe("true");
    await click(chip("Fan-out"));
    expect(localStorage.getItem("pap.home.mode.v1")).toBe("fanout");
    await first.page.unmount();
    const again = await showHome();
    expect(chip("Fan-out").getAttribute("aria-checked")).toBe("true");
    expect(button(again.page.container, "Launch a fan-out")).toBeDefined();
  });

  it("shows New lane's chord as the Lane chip's hint (§3.2)", async () => {
    await showHome();
    expect(chip("Lane").closest("[data-tip]")?.getAttribute("data-tip")).toBe("New lane Ctrl+Shift+L");
  });

  it("Lane opens the dialog with the first line as title and the rest as description; Fan-out with two slots", async () => {
    const { page, actions } = await showHome();
    await click(chip("Lane"));
    await typeInto(composer(), "Replace the cache\nKeep the API");
    await click(button(page.container, "Launch a lane"));
    expect(actions.newLane).toHaveBeenLastCalledWith({
      projectRoot: "/w/api",
      title: "Replace the cache",
      text: "Keep the API",
      models: [null],
    });
    await click(chip("Fan-out"));
    await click(button(page.container, "Launch a fan-out"));
    expect(actions.newLane).toHaveBeenLastCalledWith({
      projectRoot: "/w/api",
      title: "Replace the cache",
      text: "Keep the API",
      models: [null, null],
    });
  });

  it("Trigger opens the project's new trigger with the first line as name and the text as prompt", async () => {
    const { page, actions } = await showHome();
    await click(chip("Trigger"));
    await typeInto(composer(), "Nightly report\nSummarise the failures");
    await click(button(page.container, "Launch a trigger"));
    expect(actions.newTrigger).toHaveBeenCalledExactlyOnceWith("p1", {
      name: "Nightly report",
      prompt: "Nightly report\nSummarise the failures",
    });
  });

  it("an empty launch opens each dialog empty", async () => {
    const { page, actions } = await showHome();
    await click(chip("Lane"));
    await click(button(page.container, "Launch a lane"));
    await click(chip("Fan-out"));
    await click(button(page.container, "Launch a fan-out"));
    await click(chip("Trigger"));
    await click(button(page.container, "Launch a trigger"));
    expect(actions.newLane.mock.calls).toEqual([
      [{ projectRoot: "/w/api", title: "", text: "", models: [null] }],
      [{ projectRoot: "/w/api", title: "", text: "", models: [null, null] }],
    ]);
    expect(actions.newTrigger).toHaveBeenCalledExactlyOnceWith("p1", { name: "", prompt: "" });
  });

  it("opens a dialog with the focus in the composer, so a dialog that closes without launching gives it back (§7)", async () => {
    const { page, actions } = await showHome();
    let focused: Element | null = null;
    actions.newLane.mockImplementation(() => {
      focused = document.activeElement;
      return true;
    });
    await click(chip("Lane"));
    await click(button(page.container, "Launch a lane"));
    expect(focused).toBe(composer());
  });

  it("Enter launches, Shift+Enter is a new line, Ctrl+Enter launches too", async () => {
    const { actions } = await showHome();
    await click(chip("Lane"));
    await typeInto(composer(), "Fix");
    expect((await press(composer(), { key: "Enter", shiftKey: true })).defaultPrevented).toBe(false);
    expect(actions.newLane).not.toHaveBeenCalled();
    expect((await press(composer(), { key: "Enter" })).defaultPrevented).toBe(true);
    expect(actions.newLane).toHaveBeenCalledTimes(1);
    await press(composer(), { key: "Enter", ctrlKey: true });
    expect(actions.newLane).toHaveBeenCalledTimes(2);
  });

  it("an input method's Enter never launches; a phone's Enter is a new line (Review Focus 3)", async () => {
    const first = await showHome();
    await click(chip("Lane"));
    await typeInto(composer(), "Fix");
    expect((await press(composer(), { key: "Enter", isComposing: true })).defaultPrevented).toBe(false);
    expect(first.actions.newLane).not.toHaveBeenCalled();
    await first.page.unmount();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const phone = await showHome();
    await typeInto(composer(), "Fix");
    expect((await press(composer(), { key: "Enter" })).defaultPrevented).toBe(false);
    expect(phone.actions.newLane).not.toHaveBeenCalled();
    await click(button(phone.page.container, "Launch a lane"));
    expect(phone.actions.newLane).toHaveBeenCalledTimes(1);
  });

  it("disables Lane and Fan-out with their reason in a folder that is not a git repository (§3.2, §7)", async () => {
    bed.handlers["lanes.preview"] = () => ({ repo: false });
    await showHome();
    await settle();
    expect(bed.called("lanes.preview")[0]?.params).toEqual({ projectRoot: "/w/api" });
    for (const label of ["Lane", "Fan-out"]) {
      expect(chip(label).getAttribute("aria-disabled")).toBe("true");
      expect(reasonOf(chip(label))).toBe("Lane and Fan-out: not a git repository.");
    }
    await click(chip("Lane"));
    expect(chip("Session").getAttribute("aria-checked")).toBe("true");
  });

  it("falls back to Session for a remembered Lane in such a folder, and keeps the choice for other projects (PH14)", async () => {
    localStorage.setItem("pap.home.mode.v1", "lane");
    bed.handlers["lanes.preview"] = () => ({ repo: false });
    const { page } = await showHome();
    await settle();
    expect(button(page.container, "Launch a session")).toBeDefined();
    expect(localStorage.getItem("pap.home.mode.v1")).toBe("lane");
  });

  it("disables Trigger while automation is paused, or with a $0 daily budget", async () => {
    useTasksStore.getState().apply(tasksSnapshot([], { paused: true }));
    await showHome();
    expect(chip("Trigger").getAttribute("aria-disabled")).toBe("true");
    expect(reasonOf(chip("Trigger"))).toBe("Trigger: automation is paused.");
    await act(async () => useTasksStore.getState().apply(tasksSnapshot([], { budgetUsd: 0 })));
    expect(reasonOf(chip("Trigger"))).toBe("Trigger: the daily budget is $0, so no trigger can run.");
  });
});
```

(The phone half of the Review Focus 3 test relies on `chip("Lane")` being chosen already: the mode was remembered by the first half, so the phone's composer starts in Lane.)

Create `apps/web/src/features/home/ProjectHome.picker.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, press, settle, typeInto } from "../../testing/dom.ts";
import { chip, composer, resetHome, showHome } from "../../testing/home-bed.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const picker = () => document.querySelector("[data-project-picker]") as HTMLElement | null;
const waitPicker = () => vi.waitFor(() => expect(picker()).not.toBeNull(), { timeout: 2_000 });
const choices = () => [...(picker()?.querySelectorAll("button") ?? [])].map((node) => node.textContent);

beforeAll(async () => {
  await import("./ProjectPicker.tsx");
});
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["sessions.create"] = () => ({ sessionId: "new-1" });
  resetHome(null);
});

describe("ProjectHome under All projects (§3.5, PH13)", () => {
  it("asks which project at Launch, lists the projects then Add project…, and launches in the one picked", async () => {
    useShellStore.getState().apply({
      kind: "project",
      project: shellProject({ id: "p3", name: "fresh", root: "/w/fresh", position: 3, sessions: 0, unused: true }),
    });
    const { page, actions } = await showHome();
    expect(page.container.querySelector("h1")?.textContent).toBe("All projects");
    expect(composer().getAttribute("placeholder")).toBe("What do you want to do? Launch asks which project.");
    await click(chip("Lane"));
    await typeInto(composer(), "Fix");
    await click(button(page.container, "Launch a lane"));
    await waitPicker();
    expect(choices()).toEqual(["api", "web", "fresh", "Add project…", "Cancel"]);
    expect(document.activeElement?.textContent).toBe("api");
    await click(button(picker() as HTMLElement, "web"));
    expect(actions.newLane).toHaveBeenCalledExactlyOnceWith({ projectRoot: "/w/web", title: "Fix", text: "Fix", models: [null] });
    expect(picker()).toBeNull();
    expect(useCurrentProject.getState().projectId).toBeNull();
  });

  it("a Session launch asks too, then creates the session in the chosen project's root", async () => {
    const { page } = await showHome();
    await click(button(page.container, "Launch a session"));
    await waitPicker();
    await click(button(picker() as HTMLElement, "api"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/w/api", preset: "configured" });
  });

  it("Add project… opens the dialog, and the launch goes on in the project once it is added", async () => {
    const { page, actions } = await showHome();
    await click(chip("Trigger"));
    await typeInto(composer(), "Nightly");
    await click(button(page.container, "Launch a trigger"));
    await waitPicker();
    await click(button(picker() as HTMLElement, "Add project…"));
    expect(actions.addProject).toHaveBeenCalledOnce();
    const onAdded = actions.addProject.mock.calls[0]?.[0];
    await act(async () => {
      useShellStore.getState().apply({
        kind: "project",
        project: { id: "p9", root: "/w/new", name: "new", position: 0, sessions: 0, unused: true },
      });
      useCurrentProject.getState().choose("p9");
      onAdded?.("p9");
    });
    expect(actions.newTrigger).toHaveBeenCalledExactlyOnceWith("p9", { name: "Nightly", prompt: "Nightly" });
  });

  it("Escape closes the picker and gives the focus back to the composer", async () => {
    const { page, actions } = await showHome();
    await click(button(page.container, "Launch a session"));
    await waitPicker();
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(composer());
    expect(actions.open).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/ProjectHome.test.tsx apps/web/src/features/home/ProjectHome.modes.test.tsx apps/web/src/features/home/ProjectHome.picker.test.tsx`
Expected: FAIL — `ProjectHome.tsx` does not exist.

- [ ] **Step 5: The chips, the picker, the composer**

Create `apps/web/src/features/home/ModeChips.tsx`:

```tsx
import { Tooltip } from "@pap/ui";
import { type ReactElement, useId, useRef } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import type { HomeChord } from "./home-actions.ts";
import { HOME_MODES, type HomeMode } from "./home-mode.ts";

const CHIP_CLASSES =
  "inline-flex h-control items-center rounded-sm border border-control-border px-s2 label-hud text-muted focus-ring aria-checked:border-agent aria-checked:text-fg aria-disabled:opacity-50 pointer-coarse:min-h-11";

const STEPS: Readonly<Record<string, 1 | -1 | "first" | "last">> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

interface Props {
  /** The mode shown checked (a refused one shows Session). */
  readonly mode: HomeMode;
  readonly reasons: Partial<Record<HomeMode, MessageKey>>;
  readonly laneChord: HomeChord;
  onMode(mode: HomeMode): void;
}

/**
 * §3.1 and §7: Session · Lane · Fan-out · Trigger as one radiogroup (a roving tab stop, arrow keys, Home and End). A mode
 * that cannot run stays visible, `aria-disabled`, and its reason is a visible line its `aria-describedby` names.
 */
export function ModeChips({ mode, reasons, laneChord, onMode }: Props) {
  const t = useT();
  const group = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const open = HOME_MODES.filter((one) => reasons[one] === undefined);
  const lines = [...new Set(HOME_MODES.flatMap((one) => reasons[one] ?? []))];
  const move = (step: 1 | -1 | "first" | "last") => {
    const at = open.indexOf(mode);
    const next =
      step === "first" ? open[0] : step === "last" ? open.at(-1) : open[(at + step + open.length) % open.length];
    if (next === undefined) return;
    onMode(next);
    group.current?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };
  return (
    <div className="flex flex-col gap-s1">
      <div
        ref={group}
        role="radiogroup"
        aria-label={t("launch.modes")}
        className="flex flex-wrap gap-s1"
        onKeyDown={(event) => {
          const step = STEPS[event.key];
          if (step === undefined) return;
          event.preventDefault();
          move(step);
        }}
      >
        {HOME_MODES.map((one) => {
          const reason = reasons[one];
          const chip: ReactElement = (
            <button
              key={one}
              type="button"
              role="radio"
              data-mode={one}
              aria-checked={mode === one}
              aria-disabled={reason === undefined ? undefined : true}
              aria-describedby={reason === undefined ? undefined : `${reasonId}-${lines.indexOf(reason)}`}
              tabIndex={mode === one ? 0 : -1}
              className={CHIP_CLASSES}
              onClick={() => {
                if (reason === undefined) onMode(one);
              }}
            >
              {t(`launch.mode.${one}`)}
            </button>
          );
          return one === "lane" && laneChord.keys.length > 0 ? (
            <Tooltip key={one} label={t("launch.hint.lane")} shortcut={laneChord.keys} shortcutJoiner={laneChord.joiner}>
              {chip}
            </Tooltip>
          ) : (
            chip
          );
        })}
      </div>
      {lines.map((line, index) => (
        <p key={line} id={`${reasonId}-${index}`} className="text-ui text-muted">
          {t(line)}
        </p>
      ))}
    </div>
  );
}
```

Create `apps/web/src/features/home/ProjectPicker.tsx`:

```tsx
import "../../i18n/register-home.ts";
import type { ProjectSummary } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/index.ts";

export interface ProjectPickerProps {
  readonly projects: readonly ProjectSummary[];
  onPick(projectId: string): void;
  onAdd(): void;
  onClose(): void;
}

/** "All projects" (§3.5, PH13): Launch asks which project first. The first choice takes the focus; Escape closes it. */
export default function ProjectPicker({ projects, onPick, onAdd, onClose }: ProjectPickerProps) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector("button")?.focus();
  }, []);
  return (
    <div
      ref={box}
      role="group"
      aria-label={t("home.picker.label")}
      data-project-picker=""
      className="flex flex-col gap-s2 rounded-sm border border-border bg-surface p-s3"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <p className="label-hud text-muted">{t("home.picker.label")}</p>
      <div className="flex flex-wrap gap-s2">
        {projects.map((project) => (
          <Button key={project.id} size="sm" onClick={() => onPick(project.id)}>
            {project.name}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={onAdd}>
          {t("home.picker.add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("home.picker.cancel")}
        </Button>
      </div>
    </div>
  );
}
```

Create `apps/web/src/features/home/ProjectHome.tsx`:

```tsx
import type { ToolPreset } from "@pap/contracts";
import { Button, TextField, useIsPhone } from "@pap/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { getRuntime, useConnectionState } from "../../runtime/index.ts";
import { listedProjects, useCurrentProject, useEffectiveProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import type { HomeActions, HomeShortcuts } from "./home-actions.ts";
import { type HomeMode, isLaunchKey, readMode, rememberMode } from "./home-mode.ts";
import { ModeChips } from "./ModeChips.tsx";
import { modeReasons, useGitFact } from "./project-facts.ts";
import { useLaunch } from "./use-launch.ts";

// The "All projects" picker is a chunk of its own, with the home's lazy catalog: fetched on the first Launch there.
const loadPicker = () => import("./ProjectPicker.tsx");

export interface ProjectHomeProps {
  readonly actions: HomeActions;
  readonly shortcuts: HomeShortcuts;
  readonly preset: ToolPreset;
  /** The tool preset field (Session options): another feature's, so the shell renders it. */
  presetField(disabled: boolean): ReactNode;
}

/**
 * The project home (decision 85, §3): the composer first, focused — a mode, one field, Launch. Eager, so the first
 * paint at "/" waits for no chunk. Everything it opens goes through `actions`, which the shell builds.
 */
export function ProjectHome({ actions, shortcuts, preset, presetField }: ProjectHomeProps) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const phone = useIsPhone();
  const connection = useConnectionState(getRuntime().connection);
  const project = useEffectiveProject();
  const projects = useShellStore((state) => state.view.projects);
  const counts = useTasksStore((state) => state.view.counts);
  const git = useGitFact(project?.root ?? null);
  const reasons = project === null ? {} : modeReasons({ git, counts });
  const field = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const optionsId = useId();
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<HomeMode>(readMode);
  const [options, setOptions] = useState(false);
  const [picking, setPicking] = useState(false);
  const { launch, busy, error } = useLaunch(actions, preset);
  // "New session here" (a project's menu) asks for a session there: Session mode, and the composer takes the focus.
  const startedHere = useCurrentProject((state) => state.startedHere);
  const [seenStart, setSeenStart] = useState(startedHere);
  if (seenStart !== startedHere) {
    setSeenStart(startedHere);
    setChosen("session");
  }
  useEffect(() => {
    field.current?.focus();
  }, [startedHere]);
  // A mode this project refuses shows Session here; the device keeps the choice for the others (PH14).
  const mode: HomeMode = reasons[chosen] === undefined ? chosen : "session";
  const offline = connection !== "open";

  const go = () => {
    if (busy || offline) return;
    // The focus sits in the composer when a dialog opens, so one that closes without launching gives it back (§7).
    field.current?.focus();
    if (project === null) {
      setPicking(true);
      return;
    }
    launch(mode, project, text);
  };
  const continueIn = (projectId: string) => {
    setPicking(false);
    field.current?.focus();
    const target = useShellStore.getState().view.projects.get(projectId);
    if (target !== undefined) launch(chosen, target, text);
  };

  return (
    <section
      data-home=""
      aria-labelledby={titleId}
      className="mx-auto flex w-full max-w-3xl flex-col gap-s4 overflow-y-auto p-s4"
    >
      <h1 id={titleId} className="text-xl font-extrabold text-fg">
        {project?.name ?? t("shell.project.all")}
      </h1>
      <form
        className="flex flex-col gap-s2"
        onSubmit={(event) => {
          event.preventDefault();
          go();
        }}
      >
        <ModeChips
          mode={mode}
          reasons={reasons}
          laneChord={shortcuts.lane}
          onMode={(next) => {
            setChosen(next);
            rememberMode(next);
          }}
        />
        <TextField
          label={t("launch.field")}
          value={text}
          onChange={setText}
          multiline
          rows={3}
          name="launch"
          inputRef={field}
          placeholder={
            project === null ? t("launch.placeholderAll") : t("launch.placeholder", { project: project.name })
          }
          onKeyDown={(event) => {
            if (!isLaunchKey(event, phone)) return;
            event.preventDefault();
            go();
          }}
          onSubmitShortcut={go}
        />
        <div className="flex flex-wrap items-center gap-s2">
          <Button type="submit" variant="primary" disabled={busy || offline} aria-label={t(`launch.go.${mode}`)}>
            {t("launch.go")}
          </Button>
          {mode === "session" ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={options}
              aria-controls={optionsId}
              onClick={() => setOptions((open) => !open)}
            >
              {t("launch.options")}
            </Button>
          ) : null}
        </div>
        {mode === "session" && options ? (
          <div id={optionsId} className="max-w-64">
            {presetField(busy)}
          </div>
        ) : null}
        {error === null ? null : (
          <p role="alert" className="text-ui text-attn">
            {error}
          </p>
        )}
      </form>
      <LazyPanel
        text={lazyText}
        load={loadPicker}
        open={picking}
        props={{
          projects: listedProjects(projects),
          onPick: continueIn,
          onAdd: () => {
            setPicking(false);
            actions.addProject(continueIn);
          },
          onClose: () => {
            setPicking(false);
            field.current?.focus();
          },
        }}
        onFailed={() => setPicking(false)}
      />
    </section>
  );
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home`
Expected: PASS.

- [ ] **Step 6: Failing shell tests (actions and pane)**

Create `apps/web/src/routes/shell/home-actions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pathOfItem } from "../../features/workspace/index.ts";
import { type CommandHandler, registerCommand } from "../../lib/command-registry.ts";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { useNewLaneRequest } from "../../stores/new-lane-request.ts";
import { type PaletteSearch, usePaletteRequest } from "../../stores/palette-request.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { homeActions } from "./home-actions.ts";
import type { Navigate } from "./tab-actions.ts";

const navigate = vi.fn(() => Promise.resolve());
const actions = () => homeActions(navigate as unknown as Navigate);
let registered: Array<() => void> = [];
const handle = (id: string, handler: CommandHandler = () => {}) => {
  const spy = vi.fn(handler);
  registered.push(registerCommand(id, spy));
  return spy;
};

beforeEach(() => {
  registered.forEach((unregister) => unregister());
  registered = [];
  navigate.mockClear();
  usePaletteRequest.setState({ search: null });
  useNewLaneRequest.setState({ prefill: null });
  useTriggerPrefill.setState({ items: {} });
  useAddProjectRequest.getState().close();
});

describe("the shell's home actions", () => {
  it("open targets by their URL", () => {
    expect(actions().href({ kind: "session", id: "s1" })).toBe(pathOfItem({ kind: "session", id: "s1" }));
    expect(actions().href({ kind: "settings", section: "automation" })).toBe("/settings/automation");
    actions().open({ kind: "compare", id: "0123456789abcdef" });
    expect(navigate).toHaveBeenCalledWith({ to: "/compare/0123456789abcdef" });
  });

  it("open the tree and the Inbox as the phone's sections when the phone shell registered them, else the drawers", () => {
    const tree = handle("drawer.tree.toggle");
    const inbox = handle("drawer.inbox.toggle");
    actions().openTree();
    actions().openInbox();
    const lists = handle("mobile.lists.open");
    const phoneInbox = handle("mobile.inbox.open");
    actions().openTree();
    actions().openInbox();
    expect([tree, inbox, lists, phoneInbox].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it("ask the palette for a project's transcript search, and drop the ask when no palette answers", () => {
    actions().openSearch("p1");
    expect(usePaletteRequest.getState().search).toBeNull();
    let seen: PaletteSearch | null = null;
    handle("palette.toggle", () => {
      seen = usePaletteRequest.getState().take();
    });
    actions().openSearch("p1");
    expect(seen).toEqual({ projectId: "p1" });
  });

  it("hand the lane prefill to the dialog's host, and take it back when no host answers", () => {
    const prefill = { projectRoot: "/w/api", title: "T", text: "d", models: [null] };
    expect(actions().newLane(prefill)).toBe(false);
    expect(useNewLaneRequest.getState().prefill).toBeNull();
    handle("lanes.new");
    expect(actions().newLane(prefill)).toBe(true);
    expect(useNewLaneRequest.getState().prefill).toEqual(prefill);
  });

  it("leave the trigger prefill for the project's new editor, then open it", () => {
    actions().newTrigger("p1", { name: "n", prompt: "p" });
    expect(useTriggerPrefill.getState().peek("p1")).toEqual({ name: "n", prompt: "p" });
    expect(navigate).toHaveBeenCalledWith({ to: pathOfItem({ kind: "trigger", id: "new:p1" }) });
  });

  it("ask for the Add project dialog with the continuation, and run the shortcuts help", () => {
    const onAdded = vi.fn();
    actions().addProject(onAdded);
    expect(useAddProjectRequest.getState()).toMatchObject({ open: true, onAdded });
    const help = handle("shortcuts.help");
    actions().openShortcuts();
    expect(help).toHaveBeenCalledOnce();
  });
});
```

Create `apps/web/src/routes/shell/HomePane.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_PRESET_KEY } from "../../features/sessions/presets.vm.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { HomePane } from "./HomePane.tsx";

const current = vi.hoisted(() => ({
  runtime: undefined as Runtime | undefined,
  navigate: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => current.navigate,
}));

let bed: ReturnType<typeof fakeRuntime>;
const select = () => document.querySelector('[role="combobox"]') as HTMLElement;
async function choose(label: string) {
  await act(async () => {
    select().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), { timeout: 2_000 });
  const option = [...document.querySelectorAll('[role="option"]')].find((one) => one.textContent === label);
  await act(async () => {
    option?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }));
    (option as HTMLElement).click();
  });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull(), { timeout: 2_000 });
  await settle();
}

// The picker is a lazy chunk: the first transform of its select stack is slow, so it is paid here, not in a test.
beforeAll(async () => {
  await import("../../features/sessions/PresetPicker.tsx");
}, 60_000);
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  bed.handlers["sessions.create"] = () => ({ sessionId: "n1" });
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore
    .getState()
    .apply(shellSnapshot([], { projects: [shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 })] }));
  useCurrentProject.setState({ projectId: "p1", storageRefused: false, startedHere: 0 });
  current.navigate.mockClear();
});

describe("the home pane (the shell's side of the home)", () => {
  it("sends the preset chosen under Session options, remembers it for this device, and opens the session", async () => {
    const page = await mount(<HomePane />);
    await settle();
    await click(button(page.container, "Session options"));
    await act(async () => {
      await vi.waitFor(() => expect(select()).not.toBeNull(), { timeout: 10_000 });
    });
    expect(select().textContent).toBe("Configured");
    await choose("Read-only");
    expect(localStorage.getItem(LAST_PRESET_KEY)).toBe("read-only");
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/w/api", preset: "read-only" });
    expect(current.navigate).toHaveBeenCalledWith({ to: "/s/n1" });
  });

  it("opens the tasks stream while the home shows, and closes it when the home goes (§8)", async () => {
    const page = await mount(<HomePane />);
    await settle();
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    await page.unmount();
    expect(bed.called("unsubscribe")).toHaveLength(1);
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/routes/shell/home-actions.test.ts apps/web/src/routes/shell/HomePane.test.tsx`
Expected: FAIL — the modules do not exist.

- [ ] **Step 7: The shell's actions and the pane**

Create `apps/web/src/routes/shell/home-actions.ts`:

```ts
import type { HomeActions } from "../../features/home/home-actions.ts";
import { pathOfItem } from "../../features/workspace/index.ts";
import { runCommand } from "../../lib/command-registry.ts";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { useNewLaneRequest } from "../../stores/new-lane-request.ts";
import { usePaletteRequest } from "../../stores/palette-request.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { go, type Navigate } from "./tab-actions.ts";

/**
 * What the home opens, in the shell's terms: tabs by their URL, drawers and dialogs by their commands, prefills by
 * their stores. On a phone, the Lists and Inbox sections stand in for the drawers (their commands exist only there).
 */
export function homeActions(navigate: Navigate): HomeActions {
  return {
    href: (target) => pathOfItem(target),
    open: (target) => go(navigate, pathOfItem(target)),
    openTree: () => {
      if (!runCommand("mobile.lists.open")) runCommand("drawer.tree.toggle");
    },
    openInbox: () => {
      if (!runCommand("mobile.inbox.open")) runCommand("drawer.inbox.toggle");
    },
    openSearch: (projectId) => {
      usePaletteRequest.getState().askSearch(projectId);
      if (!runCommand("palette.toggle")) usePaletteRequest.getState().take();
    },
    openShortcuts: () => {
      runCommand("shortcuts.help");
    },
    newLane: (prefill) => {
      useNewLaneRequest.getState().request(prefill);
      if (runCommand("lanes.new")) return true;
      useNewLaneRequest.getState().take();
      return false;
    },
    newTrigger: (projectId, prefill) => {
      useTriggerPrefill.getState().put(projectId, prefill);
      go(navigate, pathOfItem({ kind: "trigger", id: `new:${projectId}` }));
    },
    addProject: (onAdded) => useAddProjectRequest.getState().ask(onAdded),
  };
}
```

Create `apps/web/src/routes/shell/HomePane.tsx`:

```tsx
import type { ToolPreset } from "@pap/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ProjectHome } from "../../features/home/ProjectHome.tsx";
import { lastPreset, rememberPreset } from "../../features/sessions/presets.vm.ts";
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { homeActions } from "./home-actions.ts";
import { useShortcut } from "./shortcut.ts";
import { useTasksFeed } from "./use-tasks-feed.ts";

// The picker (Select and its strings) is a chunk of its own: the home stays within the initial bundle.
const loadPicker = () => import("../../features/sessions/PresetPicker.tsx");

/**
 * The home pane (decision 85): the shell's side of `ProjectHome` — its actions, the chords it shows, the tool preset
 * field (another feature's), and the `tasks` stream, open while the home shows (§8).
 */
export function HomePane() {
  const navigate = useNavigate();
  const lazyText = useLazyFailureText();
  const { Lazy: Picker, attempt, retry } = useRetryableLazy(loadPicker);
  const [preset, setPreset] = useState<ToolPreset>(lastPreset);
  useTasksFeed(true);
  const actions = useMemo(() => homeActions(navigate), [navigate]);
  const lane = useShortcut("lanes.new");
  const search = useShortcut("palette.toggle");
  const help = useShortcut("shortcuts.help");
  const shortcuts = useMemo(() => ({ lane, search, help }), [lane, search, help]);
  return (
    <ProjectHome
      actions={actions}
      shortcuts={shortcuts}
      preset={preset}
      presetField={(disabled) => (
        <LazyBoundary
          resetKey={attempt}
          onError={(error) => {
            retry();
            notifyLazyFailure(error, lazyText);
          }}
        >
          <Picker
            value={preset}
            disabled={disabled}
            onChange={(next) => {
              setPreset(next);
              rememberPreset(next);
            }}
          />
        </LazyBoundary>
      )}
    />
  );
}
```

`apps/web/src/routes/shell/pane-renderers.tsx`: replace `import { SessionListScreen } from "../../features/sessions/SessionListScreen.tsx";` with `import { HomePane } from "./HomePane.tsx";`, change the renderer to `home: () => <HomePane />,`, and the comment above `loadSession` to "The home (the project home's composer) stays eager: the first paint at "/" does not wait for a fetch."

Run: `pnpm exec vitest run --project unit apps/web/src/routes/shell/home-actions.test.ts apps/web/src/routes/shell/HomePane.test.tsx`
Expected: PASS.

- [ ] **Step 8: The old home goes**

```bash
git rm apps/web/src/features/sessions/SessionListScreen.tsx \
  apps/web/src/features/sessions/SessionListScreen.test.tsx \
  apps/web/src/features/sessions/SessionListScreen.preset.test.tsx
```

Where its tests went: creation, refusal, offline, unknown outcome, project root, "New session here" and the preset → `ProjectHome.test.tsx` and `HomePane.test.tsx`; the list, its labels, markup as text, the window and loading/error states → `RecentWork.test.tsx` (Task 8); "All sessions" → the status line's lanes part and Recent work (the ⌘B tree keeps its own button in the top bar).

- [ ] **Step 9: Point the shell tests' home stub at the new pane**

```bash
cd /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/apps/web/src
for f in routes/shell/*.test.tsx; do
  sed -i 's#vi.mock("../../features/sessions/SessionListScreen.tsx"#vi.mock("./HomePane.tsx"#; s#return { SessionListScreen:#return { HomePane:#' "$f"
done
for f in routes/settings/*.test.tsx; do
  sed -i 's#vi.mock("../../features/sessions/SessionListScreen.tsx"#vi.mock("../shell/HomePane.tsx"#; s#return { SessionListScreen:#return { HomePane:#' "$f"
done
rtk proxy grep -rn "SessionListScreen" . || echo "none left"
```

Expected: `none left`. (`HomePane.test.tsx` has no such mock and is untouched.)

Run: `pnpm exec vitest run --project unit apps/web/src`
Expected: PASS.

- [ ] **Step 10: Gate and commit**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip`
Expected: clean.

```bash
git add -A apps/web/src
git commit -m "feat(home): the project home's composer replaces the session list as the home"
```

---
### Task 11: The home's body — action row, assembly, Settings › Home, the lazy chunk

Track J. Spec §3.2, §3.3/§3.4 assembly, §6 (hiding), §7, §8 (bundle), §9 ("a disabled action showing its reason", "the Settings › Home checkboxes hiding each part"). Rulings PH9, PH12, PH13.

**Files:**
- Create: `apps/web/src/features/home/use-root-access.ts`
- Create: `apps/web/src/features/home/ActionRow.tsx`, `ActionRow.test.tsx`
- Create: `apps/web/src/features/home/HomeBody.tsx`, `HomeBody.test.tsx`
- Modify: `apps/web/src/features/home/ProjectHome.tsx` (`layout`, the lazy body)
- Modify: `apps/web/src/routes/shell/HomePane.tsx` (`layout`)
- Modify: `apps/web/src/testing/home-bed.tsx`; `ProjectHome.test.tsx`, `ProjectHome.modes.test.tsx`, `ProjectHome.picker.test.tsx`, `HomePane.test.tsx` (stub the body)
- Modify: `apps/web/src/i18n/catalog/home.ts`, `lazy-catalog.home.test.ts`
- Modify: `apps/web/src/build-output.int.test.ts`

**Interfaces:**
- Consumes: `StatusLine` (Task 7), `RecentWork` (Task 8), `HomeLayout`, `DEFAULT_HOME_LAYOUT` (Task 4), `HomeActions`, `HomeShortcuts`, `HomeChord` (Task 7), `ProjectHome` (Task 10); `files.list { path }`, `terminal.create { requestId, cwd, cols, rows }` → `{ terminalId }`; `randomId(bytes)` (`runtime/random-id.ts`).
- Produces: `useRootAccess(root: string | null): MessageKey | null`; `ActionRow({ project, layout, actions, shortcuts })`; `HomeBody` (default export: `{ project: ProjectSummary | null; layout: HomeLayout; actions: HomeActions; shortcuts: HomeShortcuts }`), the lazy chunk marked `data-home-body`; `ProjectHomeProps.layout: HomeLayout`.

- [ ] **Step 1: Failing action-row tests**

Create `apps/web/src/features/home/ActionRow.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { DEFAULT_HOME_LAYOUT, type HomeLayout } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeHomeActions, SHORTCUTS } from "../../testing/home-actions.ts";
import { laneSnapshot } from "../../testing/lane-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject } from "../../testing/shell-snapshot.ts";
import { ActionRow } from "./ActionRow.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
const TERMINAL = "A".repeat(22);
let bed: ReturnType<typeof fakeRuntime>;
let actions: ReturnType<typeof fakeHomeActions>;
const show = async (project: typeof api | null = api, layout: HomeLayout = DEFAULT_HOME_LAYOUT) => {
  const page = await mount(<ActionRow project={project} layout={layout} actions={actions} shortcuts={SHORTCUTS} />);
  await settle();
  return page.container;
};
const reasonOf = (node: HTMLElement) => document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent;

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["files.list"] = () => ({ entries: [], truncated: false });
  bed.handlers["terminal.create"] = () => ({ terminalId: TERMINAL });
  actions = fakeHomeActions();
  useLaneStore.getState().reset();
  useLaneStore.getState().apply(laneSnapshot([], [], 2));
  useInboxStore.getState().reset();
  useInboxStore.getState().apply({ kind: "counts", unread: 3, toHandle: 0 });
});

describe("the action row (§3.2)", () => {
  it("shows four labelled groups and their buttons", async () => {
    const container = await show();
    const groups = [...container.querySelectorAll("[data-home-actions] section")].map((section) => [
      section.querySelector("h2")?.textContent,
      [...section.querySelectorAll("button")].map((node) => node.getAttribute("aria-label") ?? node.textContent),
    ]);
    expect(groups).toEqual([
      ["Explore", ["Files", "Terminal", "Search"]],
      ["Automate", ["Tasks", "Inbox"]],
      ["Project", ["Archived lanes (2)", "Project settings"]],
      ["Help", ["Keyboard shortcuts"]],
    ]);
    expect(container.querySelector("[data-home-actions] h2")?.className).toContain("label-hud");
  });

  it("shows a shortcut as a hint where there is one, and the unread count on Inbox", async () => {
    const container = await show();
    expect(text(button(container, "Search"))).toBe("SearchCtrl+K");
    expect(text(button(container, "Keyboard shortcuts"))).toBe("Keyboard shortcuts?");
    expect(text(button(container, "Inbox"))).toContain("3");
  });

  it("opens Files in the root, Search for the project, Tasks, the Inbox, the tree and the shortcuts", async () => {
    const container = await show();
    for (const name of ["Files", "Search", "Tasks", "Inbox", "Archived lanes (2)", "Keyboard shortcuts"])
      await click(button(container, name));
    expect(actions.open.mock.calls).toEqual([[{ kind: "files", root: "/w/api" }], [{ kind: "tasks" }]]);
    expect(actions.openSearch).toHaveBeenCalledExactlyOnceWith("p1");
    expect(actions.openInbox).toHaveBeenCalledOnce();
    expect(actions.openTree).toHaveBeenCalledOnce();
    expect(actions.openShortcuts).toHaveBeenCalledOnce();
  });

  it("starts a terminal in the root and opens it; a refusal disables Terminal and says why", async () => {
    const container = await show();
    await click(button(container, "Terminal"));
    await settle();
    expect(bed.called("terminal.create")[0]?.params).toMatchObject({ cwd: "/w/api", cols: 80, rows: 24 });
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "terminal", id: TERMINAL });
    bed.handlers["terminal.create"] = () => {
      throw new RpcError("capacity");
    };
    await click(button(container, "Terminal"));
    await settle();
    expect(button(container, "Terminal").disabled).toBe(true);
    expect(reasonOf(button(container, "Terminal"))).toBe("The server is at capacity. Try again later.");
  });

  it("disables Files and Terminal with their reason when the workspace refuses the root (PH12)", async () => {
    bed.handlers["files.list"] = () => {
      throw new RpcError("not_found");
    };
    const container = await show();
    expect(bed.called("files.list")[0]?.params).toEqual({ path: "/w/api" });
    for (const name of ["Files", "Terminal"]) {
      expect(button(container, name).disabled).toBe(true);
      expect(reasonOf(button(container, name))).toBe("pap cannot open this folder.");
    }
    expect(button(container, "Search").disabled).toBe(false);
  });

  it("keeps Files and Terminal open when the check itself fails (an unknown fact never disables)", async () => {
    bed.handlers["files.list"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show();
    expect(button(container, "Files").disabled).toBe(false);
  });

  it("says Choose a project first under All projects, and the global actions work (PH13)", async () => {
    const container = await show(null);
    for (const name of ["Files", "Terminal"]) expect(reasonOf(button(container, name))).toBe("Choose a project first.");
    await click(button(container, "Search"));
    expect(actions.openSearch).toHaveBeenCalledExactlyOnceWith(null);
    expect(bed.called("files.list")).toEqual([]);
  });

  it("Project settings links to Skills and trust, MCP servers and Approvals (PH9)", async () => {
    const container = await show();
    await click(button(container, "Project settings"));
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), { timeout: 2_000 });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Skills and trust", "MCP servers", "Approvals"]);
    await click(items[1] as HTMLElement);
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "settings", section: "mcp" });
  });

  it("hides each group Settings › Appearance › Home hides, and itself when all are (§6)", async () => {
    const container = await show(api, { ...DEFAULT_HOME_LAYOUT, explore: false, help: false });
    expect([...container.querySelectorAll("[data-home-actions] h2")].map((node) => node.textContent)).toEqual([
      "Automate",
      "Project",
    ]);
    const none = await show(api, { ...DEFAULT_HOME_LAYOUT, explore: false, automate: false, project: false, help: false });
    expect(none.querySelector("[data-home-actions]")).toBeNull();
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/ActionRow.test.tsx`
Expected: FAIL — `ActionRow.tsx` does not exist.

- [ ] **Step 2: The root check, the strings and the row**

Append to `homeEn` in `apps/web/src/i18n/catalog/home.ts`:

```ts
  "home.group.explore": "Explore",
  "home.group.automate": "Automate",
  "home.group.project": "Project",
  "home.group.help": "Help",
  "home.action.files": "Files",
  "home.action.terminal": "Terminal",
  "home.action.search": "Search",
  "home.action.tasks": "Tasks",
  "home.action.inbox": "Inbox",
  "home.action.inboxCount": "{count} unread",
  "home.action.archived": "Archived lanes ({count})",
  "home.action.project": "Project settings",
  "home.action.skills": "Skills and trust",
  "home.action.mcp": "MCP servers",
  "home.action.approvals": "Approvals",
  "home.action.shortcuts": "Keyboard shortcuts",
  "home.reason.noProject": "Choose a project first.",
  "home.reason.rootRefused": "pap cannot open this folder.",
```

and to `homeFr`:

```ts
  "home.group.explore": "Explorer",
  "home.group.automate": "Automatiser",
  "home.group.project": "Projet",
  "home.group.help": "Aide",
  "home.action.files": "Fichiers",
  "home.action.terminal": "Terminal",
  "home.action.search": "Rechercher",
  "home.action.tasks": "Tâches",
  "home.action.inbox": "Boîte",
  "home.action.inboxCount": "{count} non lus",
  "home.action.archived": "Lanes archivées ({count})",
  "home.action.project": "Réglages du projet",
  "home.action.skills": "Skills et confiance",
  "home.action.mcp": "Serveurs MCP",
  "home.action.approvals": "Approbations",
  "home.action.shortcuts": "Raccourcis clavier",
  "home.reason.noProject": "Choisissez d'abord un projet.",
  "home.reason.rootRefused": "pap ne peut pas ouvrir ce dossier.",
```

In `lazy-catalog.home.test.ts`, add `"features/home/ActionRow.tsx"`, `"features/home/HomeBody.tsx"` and `"features/home/use-root-access.ts"` to `IN_CHUNK`.

Create `apps/web/src/features/home/use-root-access.ts`:

```ts
import { useEffect, useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

/**
 * Whether the workspace module opens the project's root (`files.list`), once per root. Only its refusal
 * (`not_found`, `forbidden`) disables Files and Terminal; a timeout or an offline socket says nothing (PH12).
 */
export function useRootAccess(root: string | null): MessageKey | null {
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    if (root === null) return undefined;
    let current = true;
    getRuntime()
      .rpc.call("files.list", { path: root })
      .then(
        () => {
          if (current) setRefused(null);
        },
        (failure: unknown) => {
          if (current && failure instanceof RpcError && (failure.code === "not_found" || failure.code === "forbidden"))
            setRefused(root);
        },
      );
    return () => {
      current = false;
    };
  }, [root]);
  return root !== null && refused === root ? "home.reason.rootRefused" : null;
}
```

Create `apps/web/src/features/home/ActionRow.tsx`:

```tsx
import "../../i18n/register-home.ts";
import type { HomeLayout, ProjectSummary } from "@pap/contracts";
import { Badge, Button, Icon, IconSettings, Kbd } from "@pap/ui";
import { type ReactNode, useId, useState } from "react";
import { errorKey, type MessageKey, useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { randomId } from "../../runtime/random-id.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import type { HomeActions, HomeChord, HomeSettingsSection, HomeShortcuts } from "./home-actions.ts";
import { useRootAccess } from "./use-root-access.ts";

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-s1">
      <h2 id={id} className="label-hud text-muted">
        {title}
      </h2>
      <div className="flex flex-wrap items-start gap-s2">{children}</div>
    </section>
  );
}

/** A visible action; one that cannot run stays, disabled, its reason visible and named by `aria-describedby` (§3.2, §7). */
function Action(props: {
  readonly label: string;
  readonly reason: string | null;
  readonly chord?: HomeChord;
  readonly children?: ReactNode;
  onClick(): void;
}) {
  const id = useId();
  return (
    <span className="flex flex-col gap-s1">
      <Button
        size="sm"
        aria-label={props.label}
        disabled={props.reason !== null}
        aria-describedby={props.reason === null ? undefined : id}
        onClick={props.onClick}
      >
        {props.label}
        {props.children}
        {props.chord !== undefined && props.chord.keys.length > 0 ? (
          <Kbd keys={props.chord.keys} joiner={props.chord.joiner} />
        ) : null}
      </Button>
      {props.reason === null ? null : (
        <span id={id} className="text-ui text-muted">
          {props.reason}
        </span>
      )}
    </span>
  );
}

interface Props {
  readonly project: ProjectSummary | null;
  readonly layout: HomeLayout;
  readonly actions: HomeActions;
  readonly shortcuts: HomeShortcuts;
}

/** §3.2: Explore · Automate · Project · Help, each group hidden from Settings › Appearance › Home. */
export function ActionRow({ project, layout, actions, shortcuts }: Props) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const unread = useInboxStore((state) => state.view.unread);
  const archived = useLaneStore((state) => state.view.archived);
  const root = project?.root ?? null;
  const access = useRootAccess(root);
  const [terminal, setTerminal] = useState<{ readonly root: string; readonly key: MessageKey } | null>(null);
  if (!layout.explore && !layout.automate && !layout.project && !layout.help) return null;

  const rootReason: MessageKey | null = root === null ? "home.reason.noProject" : access;
  const terminalReason = rootReason ?? (terminal !== null && terminal.root === root ? terminal.key : null);
  const openTerminal = () => {
    if (root === null) return;
    getRuntime()
      .rpc.call("terminal.create", { requestId: randomId(16), cwd: root, cols: 80, rows: 24 })
      .then(
        (created) => actions.open({ kind: "terminal", id: created.terminalId }),
        (failure: unknown) =>
          setTerminal({ root, key: errorKey(failure instanceof RpcError ? failure.code : "internal") }),
      );
  };
  const settings = (section: HomeSettingsSection, label: MessageKey) => ({
    id: section,
    label: t(label),
    onSelect: () => actions.open({ kind: "settings", section }),
  });

  return (
    <div data-home-actions="" className="flex flex-wrap gap-s4">
      {layout.explore ? (
        <Group title={t("home.group.explore")}>
          <Action
            label={t("home.action.files")}
            reason={rootReason === null ? null : t(rootReason)}
            onClick={() => {
              if (root !== null) actions.open({ kind: "files", root });
            }}
          />
          <Action
            label={t("home.action.terminal")}
            reason={terminalReason === null ? null : t(terminalReason)}
            onClick={openTerminal}
          />
          <Action
            label={t("home.action.search")}
            reason={null}
            chord={shortcuts.search}
            onClick={() => actions.openSearch(project?.id ?? null)}
          />
        </Group>
      ) : null}
      {layout.automate ? (
        <Group title={t("home.group.automate")}>
          <Action label={t("home.action.tasks")} reason={null} onClick={() => actions.open({ kind: "tasks" })} />
          <Action label={t("home.action.inbox")} reason={null} onClick={() => actions.openInbox()}>
            {unread > 0 ? <Badge count={unread} label={t("home.action.inboxCount", { count: unread })} /> : null}
          </Action>
        </Group>
      ) : null}
      {layout.project ? (
        <Group title={t("home.group.project")}>
          <Action
            label={t("home.action.archived", { count: archived })}
            reason={null}
            onClick={() => actions.openTree()}
          />
          <LazyMenu
            label={t("home.action.project")}
            closeLabel={t("ui.close")}
            text={lazyText}
            items={[
              settings("skills", "home.action.skills"),
              settings("mcp", "home.action.mcp"),
              settings("approvals", "home.action.approvals"),
            ]}
            trigger={(ask) => (
              <Button size="sm" onClick={ask}>
                <Icon icon={IconSettings} size={14} />
                {t("home.action.project")}
              </Button>
            )}
          />
        </Group>
      ) : null}
      {layout.help ? (
        <Group title={t("home.group.help")}>
          <Action
            label={t("home.action.shortcuts")}
            reason={null}
            chord={shortcuts.help}
            onClick={() => actions.openShortcuts()}
          />
        </Group>
      ) : null}
    </div>
  );
}
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/ActionRow.test.tsx`
Expected: PASS.

- [ ] **Step 3: Failing body test (§9 "the Settings › Home checkboxes hiding each part")**

Create `apps/web/src/features/home/HomeBody.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { DEFAULT_HOME_LAYOUT, type HomeLayout } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeHomeActions, SHORTCUTS } from "../../testing/home-actions.ts";
import { usageSummary } from "../../testing/home-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";
import HomeBody from "./HomeBody.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
const parts = () => ({
  actions: document.querySelector("[data-home-actions]") !== null,
  status: document.querySelector("[data-home-status]") !== null,
  recent: [...document.querySelectorAll("h2")].some((node) => node.textContent === "Recent work"),
});

beforeEach(() => {
  const bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["usage.summary"] = () => usageSummary();
  bed.handlers["lanes.listArchived"] = () => ({ lanes: [], hasMore: false });
  bed.handlers["files.list"] = () => ({ entries: [], truncated: false });
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [api] }));
});

describe("the home's body (§3.2–§3.4, §6)", () => {
  it("shows the action row, the status line and Recent work, and hides each part Settings › Home hides", async () => {
    const actions = fakeHomeActions();
    const body = (layout: HomeLayout) => (
      <HomeBody project={api} layout={layout} actions={actions} shortcuts={SHORTCUTS} />
    );
    const page = await mount(body(DEFAULT_HOME_LAYOUT));
    await settle();
    expect(document.querySelector("[data-home-body]")).not.toBeNull();
    expect(parts()).toEqual({ actions: true, status: true, recent: true });
    await page.rerender(body({ ...DEFAULT_HOME_LAYOUT, status: false }));
    expect(parts()).toEqual({ actions: true, status: false, recent: true });
    await page.rerender(body({ ...DEFAULT_HOME_LAYOUT, recent: false }));
    expect(parts()).toEqual({ actions: true, status: true, recent: false });
    await page.rerender(
      body({ ...DEFAULT_HOME_LAYOUT, explore: false, automate: false, project: false, help: false }),
    );
    expect(parts()).toEqual({ actions: false, status: true, recent: true });
  });
});
```

Run: `pnpm exec vitest run --project unit apps/web/src/features/home/HomeBody.test.tsx`
Expected: FAIL — `HomeBody.tsx` does not exist.

- [ ] **Step 4: The body and its place in the home**

Create `apps/web/src/features/home/HomeBody.tsx`:

```tsx
import "../../i18n/register-home.ts";
import type { HomeLayout, ProjectSummary } from "@pap/contracts";
import { ActionRow } from "./ActionRow.tsx";
import type { HomeActions, HomeShortcuts } from "./home-actions.ts";
import { RecentWork } from "./RecentWork.tsx";
import { StatusLine } from "./StatusLine.tsx";

export interface HomeBodyProps {
  readonly project: ProjectSummary | null;
  readonly layout: HomeLayout;
  readonly actions: HomeActions;
  readonly shortcuts: HomeShortcuts;
}

/**
 * Under the composer (§3.2–§3.4): the action row, the status line and Recent work, each hidden from Settings ›
 * Appearance › Home (§6). One lazy chunk with the home's catalog, so the initial bundle carries the composer only (§8).
 */
export default function HomeBody({ project, layout, actions, shortcuts }: HomeBodyProps) {
  return (
    <div data-home-body="" className="flex flex-col gap-s4">
      <ActionRow project={project} layout={layout} actions={actions} shortcuts={shortcuts} />
      {layout.status ? <StatusLine project={project} actions={actions} /> : null}
      {layout.recent ? <RecentWork project={project} actions={actions} /> : null}
    </div>
  );
}
```

`apps/web/src/features/home/ProjectHome.tsx`:
- imports: `HomeLayout` with `ToolPreset` from `@pap/contracts`; `LazyBoundary, notifyLazyFailure, useRetryableLazy` from `../../lib/lazy.tsx`;
- beside `loadPicker`: `const loadBody = () => import("./HomeBody.tsx");`
- add to `ProjectHomeProps`: `/** Settings › Appearance › Home (§6): which parts of the body show. */ readonly layout: HomeLayout;` and take `layout` in the parameters;
- in the body of the component: `const { Lazy: Body, attempt, retry } = useRetryableLazy(loadBody);`
- after the picker's `<LazyPanel …/>`, before `</section>`:

```tsx
      <LazyBoundary
        resetKey={attempt}
        onError={(failure) => {
          retry();
          notifyLazyFailure(failure, lazyText);
        }}
      >
        <Body project={project} layout={layout} actions={actions} shortcuts={shortcuts} />
      </LazyBoundary>
```

`apps/web/src/routes/shell/HomePane.tsx`: import `useAppearanceStore` from `../../features/appearance/index.ts`; `const layout = useAppearanceStore((state) => state.account.home);` and pass `layout={layout}` to `ProjectHome`.

`apps/web/src/testing/home-bed.tsx`: import `DEFAULT_HOME_LAYOUT` (with `ToolPreset`) from `@pap/contracts` and pass `layout={DEFAULT_HOME_LAYOUT}` to `ProjectHome`.

The composer tests do not look at the body; stub it. In `ProjectHome.modes.test.tsx` and `ProjectHome.picker.test.tsx` add after the runtime mock:

```ts
vi.mock("./HomeBody.tsx", () => ({ default: () => null }));
```

In `HomePane.test.tsx` add `vi.mock("../../features/home/HomeBody.tsx", () => ({ default: () => null }));`. In `ProjectHome.test.tsx`, stub it so the test can read what it was given, and add one test:

```tsx
const body = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("./HomeBody.tsx", () => ({
  default: (props: Record<string, unknown>) => {
    body.props = props;
    return null;
  },
}));
```

```tsx
  it("renders the lazy body under the composer with the project and the Settings › Home layout", async () => {
    await showHome();
    await vi.waitFor(() => expect(body.props).not.toBeNull(), { timeout: 2_000 });
    expect(body.props).toMatchObject({ project: { id: "p1" }, layout: DEFAULT_HOME_LAYOUT });
  });
```

(import `DEFAULT_HOME_LAYOUT` from `@pap/contracts` there.)

Run: `pnpm exec vitest run --project unit apps/web/src/features/home apps/web/src/routes/shell/HomePane.test.tsx apps/web/src/i18n`
Expected: PASS.

- [ ] **Step 5: The lazy markers and the bundle**

In `apps/web/src/build-output.int.test.ts`, after the Add project test, add:

```ts
  it("keeps the home's body, its picker and their strings out of the initial assets (decision 85)", () =>
    keepsLazyOnly([/data-home-body/, /data-project-picker/, /Recent work/, /Travail récent/]));

  it("keeps the home's composer in the initial assets: the first paint at / waits for no chunk (§8)", async () => {
    const initial = [...html.matchAll(/src="\/assets\/([^"]+\.js)"/g)].map((match) => match[1] ?? "");
    const texts = await Promise.all(initial.map((name) => readFile(join(out, "assets", name), "utf8")));
    expect(texts.some((code) => /"data-home"/.test(code) && code.includes("Launch a session"))).toBe(true);
  });
```

Run: `pnpm exec vitest run --project integration apps/web/src/build-output.int.test.ts`
Expected: PASS.

Run: `pnpm build && pnpm budgets`
Expected: `initial bundle: N KB gzip` with **N ≤ 223.7** (222.7 at 04d4871 plus 1.0 of noise). Above it: find the eager growth with `pnpm budgets` (the lazy chunk list) and the build's initial files, and move what can be lazy (strings into `home.ts`, code into `HomeBody`) before the review; if it still does not fit, stop and ask the owner. Note N in the commit body.

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm exec vitest run --project unit apps/web/src`
Expected: clean.

```bash
git add apps/web/src
git commit -m "feat(home): the action row, status line and Recent work under the composer, one lazy chunk" \
  -m "Initial bundle: N KB gzip (222.7 at 04d4871)."
```

(write the measured number for N.)

---

### Task 12: Docs and the full gate

Track J. Spec §9 ("Gates: the full gate with the budgets"), §10.

**Files:**
- Modify: `docs/agents/web.md`
- Modify: `docs/agents/sessions.md` (a "Projects" section), `docs/agents/daemon.md:56` (the projects module line)
- `AGENTS.md`: no change expected (no new command, environment variable or rule). Change it only if a gate below shows a new rule.
- Not touched: `docs/research/decisions-log.md`.

**Interfaces:**
- Consumes: everything above; the bundle number from Task 11.
- Produces: the notes a later agent reads first.

- [ ] **Step 1: `docs/agents/web.md`**

In "Shell", replace "The session screen is a lazy chunk (`pane-renderers.tsx`), the session list (home) is eager." with "The session screen is a lazy chunk (`pane-renderers.tsx`); the project home's composer (`HomePane` → `ProjectHome`) is eager, its body is a lazy chunk." Then add this section after "Automation panes, stores and bundle (M10)":

```markdown
## Project home (decision 85)

- `routes/shell/HomePane.tsx` is the `home` pane: it builds `HomeActions` (`home-actions.ts`: tabs by URL, drawers and dialogs by their commands — `mobile.lists.open` / `mobile.inbox.open` on a phone, the drawers otherwise —, prefills by their stores), the chords (`HomeShortcuts`), the tool preset field (another feature's), reads Settings › Appearance › Home (`account.home`), and keeps the `tasks` stream open while the home shows.
- `features/home/ProjectHome.tsx` (eager): the mode radiogroup (`ModeChips`, roving tab stop, arrow keys; the mode is remembered per device in `pap.home.mode.v1`), one field, Launch. Enter launches, Shift+Enter is a new line, Ctrl/⌘+Enter launches too; never during an IME composition; on a phone Enter is a new line. Session: `sessions.create` then `sessions.prompt`; a refused or unknown prompt leaves the text in the new session's composer (`useComposerPrefill`). Lane / Fan-out: `NewLanePrefill` with the first line as `title` (`launch-text.ts`). Trigger: `useTriggerPrefill` (peek in the pane's state initializer, drop in an effect: StrictMode calls initializers twice), then the `new:<project>` tab. "All projects": a lazy picker (`ProjectPicker`) asks which project; "Add project…" continues the launch in the added project.
- Ask, don't hide: Lane and Fan-out are disabled once `lanes.preview` says `repo: false`; Trigger while automation is paused or the daily budget is $0; Files and Terminal when `files.list` on the root is refused. Unknown facts never disable. Reasons are visible lines named by `aria-describedby`.
- `features/home/HomeBody.tsx` (lazy, `data-home-body`): `ActionRow` (Explore · Automate · Project · Help), `StatusLine` (lanes, running tasks, unread Inbox, 30-day spend from one `usage.summary`; no polling), `RecentWork` (sessions, lanes, fan-outs from `fanoutId`, tasks; a lane's or task's session is not a row of its own; first page of `lanes.listArchived`).
- Catalogs: eager `catalog/launch.ts` (`launch.*`); lazy `catalog/home.ts` (`home.*`, `register-home.ts`, guarded by `lazy-catalog.home.test.ts`) and `catalog/add-project.ts` (`addProject.*`).
- Add project: `features/projects/AddProjectDialog.tsx` (lazy, `data-add-project`), opened through `stores/add-project-request.ts` by the chip menu and the picker; `routes/shell/AddProjectHost.tsx` switches the chip. Check calls `projects.add` (idempotent) then `lanes.preview`; `holdProject` keeps the answer in the shell store until the stream speaks.
- The switcher and the picker list `listedProjects`: an active session, or `unused` (no session at all yet).
- ⌘K search mode: `stores/palette-request.ts` then `palette.toggle`; `CommandPalette`'s `search` prop lists hits only, filtered to the project on the client (`search.query` has no project filter).
- §5 gaps: Tasks in the rail; Keyboard shortcuts in the account menu; Compare in a fan-out lane's header (`LanePanes.openCompare`); on a phone, the logo and "+" go home and the Lists tab's menu (`MobileListsMenu`) holds Settings and the account.
- Bundle after the project home: initial N KB gzip (`pnpm budgets`), against 222.7 KB at 04d4871.
```

(write the measured N.)

- [ ] **Step 2: `docs/agents/sessions.md` and `docs/agents/daemon.md`**

Append to `docs/agents/sessions.md`:

```markdown
## Projects: `projects.add` (decision 85)

- `projects.add { root }` (`sessions:operate`, idempotent, no audit): the projects service resolves the folder with `resolveSessionCwd` (`invalid_cwd`), files it under `policy.scopeOf` (its git root, else itself) exactly as `sessions.create` does, refuses the real path or the scope inside `$PAP_HOME` or Pi's agent folder (`bad_request`, a link into them included), and calls `ensure`; a full table (2000) answers `capacity`, a database a newer pap wrote `read_only`. The composition (`daemon.ts`) passes `ProjectFolders` (`resolve`, `scopeOf`, `stateDirs`); without them `add` fails closed (`internal`).
- The `shell` snapshot lists every project with an active session and every project no session files under yet, flagged `unused: true` (`MarksStore.projectsInUse`, `ProjectsPort.all`); a `project` event carries the flag until the first session. Residual: re-adding a project whose sessions are all archived holds for the page only.
```

In `docs/agents/daemon.md` line 56, change "RPC `projects.update` (rename, move)" to "RPCs `projects.update` (rename, move) and `projects.add` (decision 85, see `sessions.md`)", and "(`ensure` one project per session folder scope, `list`, `onChange`)" to "(`ensure` one project per session folder scope, `list`, `all`, `onChange`)".

- [ ] **Step 3: The full gate**

Run, from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm knip
pnpm test:unit
pnpm test:int
pnpm build && pnpm budgets
pnpm smoke
```

Expected: every command exits 0; `pnpm budgets` prints the initial bundle at or under 223.7 KB (and the lazy chunks: `HomeBody`, `ProjectPicker`, `AddProjectDialog` among them).

- [ ] **Step 4: Commit**

```bash
git add docs/agents/web.md docs/agents/sessions.md docs/agents/daemon.md
git commit -m "docs: the project home, projects.add and the unused projects of the shell snapshot"
```

Then hand the branch to the Opus whole-branch review (model table) and, after the owner's approval, squash it into one commit (spec §10), rebased on `main` first.
