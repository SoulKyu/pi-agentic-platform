# Models batch: one picker fed by Pi's model list, plus providers and availability from Settings

Date 2026-10-17. Status: design, fixed after the red-team (`.superpowers/redteam-models.md`) and the owner's answers (question page `models-q1`, archived as `docs/design/questions/2026-10-17-models.html`; every answer is the recommendation, listed in the plan's "Owner answers (2026-10-17)"). Plan: `docs/plans/2026-10-17-models-picker-providers.md`.

## 1. Goal

The owner's words (2026-10-17): the model choice in the web UI "provides a complete list of all models available, it does not use the Pi models list from my Pi Agent, and the list does not include a scrollbar"; "every time you can pick up a model, allow to choose on the Pi Agent available models"; "configure New Providers directly from the settings and control which models are available or not (and in the future restrict models to people / projects / agents)".

Three parts, one batch:

- **A, the bug fix.** Wherever a model is picked, the choices are exactly the models Pi would let that context use. One shared, searchable picker replaces every model `Select`. The `Select` primitive scrolls.
- **B, the feature.** Settings > Models gets a provider form (add, edit, remove) and an "Available models" view that controls and previews what every picker offers.
- **C, design only.** A pap-side allow-list per user, project or agent filters the single source later (section 8). Nothing of it is built.

## 2. Root causes (confirmed in the code)

1. **Two lists.** The session menu calls `sessions.models`; the worker answers in Pi's order (`packages/pi-host/src/model-commands.ts:16-27`): the session's scope, else the scope `enabledModels` names (resolved by Pi), else `modelRuntime.getAvailable()` (providers with configured auth). The agent form (`apps/web/src/features/agents/use-agent-models.ts:24`) and the new-lane dialog (`apps/web/src/features/lanes/new-lane.vm.ts:134`, `use-new-lane-data.ts:52`) instead read `models.overview` and keep `model.enabled`. With no `enabledModels`, the overview marks every model of every provider enabled (`packages/pi-host/src/helper/ops/models-overview.ts:76`, `enabled === null || ...`), signed in or not. That flag answers "did the owner switch it off", not "can Pi use it". Hence the full catalog.
2. **No scrollbar.** `packages/ui/src/primitives/Select.tsx` is a Radix Select in `position="popper"` with no height bound and no scroll buttons. Radix hides the viewport's native scrollbar (it injects `scrollbar-width: none`), so a long list runs off the screen and cannot be scrolled. Every long `Select` has the bug.

Pickers found (`rg` for `models.overview`, `sessions.models`, `ModelPick`, `modelId` in `apps/web/src`):

| Picker | File | Source today | Verdict |
|---|---|---|---|
| Session model menu (dialog) | `features/sessions/ModelMenu.tsx` | `sessions.models` (worker) | right source, own list UI, keep as the session case of the shared list |
| Agent form model field | `features/agents/ModelFields.tsx`, `use-agent-models.ts` | `models.overview` + `enabled` | bug |
| New-lane model slots (1 to 4) | `features/lanes/ModelSlots.tsx`, `new-lane.vm.ts`, `use-new-lane-data.ts` | `models.overview` + `enabled` | bug |
| Default-model star | `features/models/EnabledSwitches.tsx` | the provider's own models | not a picker (sets the default); stays |
| Read-only displays | `AgentHeader`, `compare.vm`, `SubagentsSettings` (profile `model` text), `PiStep` (status) | none | no change |

Automation triggers and tasks carry no model field today; nothing to migrate.

## 3. The single source

**Rule.** The choices of a context are `listAvailable(runtime, patterns, sessionScope?)`, one function in `packages/pi-host/src/available-models.ts`, the same code the worker ran inline:

1. the session's own scope, if it has one (worker only);
2. else the models the `enabledModels` patterns resolve to, using Pi's `resolveModelScopeWithDiagnostics` against the runtime (so only signed-in models), if that is non-empty;
3. else `runtime.getAvailable()`.

The result carries its `origin` (`session`, `scope`, `signed-in`) so the UI can say why the list is what it is.

**Freshness.** Pi's `SettingsManager` caches `enabledModels` until `reload()` and a warm `ModelRuntime` does not see an edited `models.json` until `refresh({ allowNetwork: false })` (both probed against Pi 1.1.0). The helper opens both fresh on every call, so the worker must too: `freshAvailable` does `reload()` and `refresh()` (both offline) before it lists, unless a run is in flight (then it keeps the snapshot the run started with, since a model switch is refused while it runs). Without it the session menu would disagree with the agent form after any Settings write.

**The one stated exception.** A provider whose key is a `!command` is offered by both callers, but only the worker's default store resolves it, so it may fail at use. The picker footnote says so.

**Two callers, one function.**

- The worker (`model-commands.ts`) for a session: `sessions.models` and `set_model` validation. Unchanged behaviour, now a call.
- A new helper op `models.available { }` (cwd from the run context, like `models.overview`) for every context without a session: agent form, new lane, Settings preview. Daemon method `models.available { cwd? }`, `pi:read`, idempotent, answers `AvailableModels` (models, providers with names, origin, truncated).

**Side effects.** The helper must not run a `!command` key (MC25). Pi's `getAvailable()` runs an availability refresh that calls `checkAuth` for each provider. So the helper opens the runtime over pap's own credential store (`createAuthFileStore`, as `auth.login` does, whose `read` never resolves a command), with `refreshOnCreate: false` and `allowModelNetwork: false`. Marker tests prove no command runs. A first step of the task probes whether an expired OAuth credential makes `checkAuth` call the network; if it does, the op falls back to pap's file facts for OAuth providers (documented in the task).

**Project scope.** `models.available` takes the same `cwd` as `models.overview` and the same `ProjectsPort.covers` check; the project's `enabledModels` apply only when Pi trusts the project (`openSettings`).

**Extension providers.** The helper loads Pi offline and never runs extensions on a read (M7R46, MC52). So a no-session picker does not list models an extension registers at runtime; the session menu does (the worker has the extension runtime). Settings shows them read-only on an explicit click (section 6). This is a known difference, stated in the picker's footnote and in `docs/agents/models.md`.

**Tests that pin it to Pi.** Fixtures in a temporary agent dir (never `~/.pi/agent`): the same inputs through `listAvailable`, Pi's `resolveModelScopeWithDiagnostics` and `getAvailable()` give the same ordered ids for: no patterns, a provider glob, a model with a thinking suffix, patterns matching only unsigned providers (falls back), a session scope. Real mutation checks: drop the fallback, swap the order, use `getModels()` instead of `getAvailable()`: each turns a named test red. An integration test through the real daemon and a real worker (scripted provider) checks that `sessions.models` and `models.available` agree for one project, and again after a Settings write made while the worker is warm. A web scan test fails if a picker file calls `models.overview` for choices.

## 4. The picker

One shared component in `apps/web/src/features/models/picker/` (field + list), built on small `@pap/ui` pieces.

- **Field**: a button showing the chosen model (name, provider chip), `aria-haspopup="dialog"`. Opens an anchored popover on desktop and a bottom sheet on phones (the `Menu` pattern: `useIsPhone`); the owner chose the popover (q1). The popover is modal, so that wheel and touch scroll reach its list when it opens from a modal Dialog (the new-lane and new-agent dialogs); a real-browser check decides it (below).
- **List**: search field (focused on open, all tokens must match provider, id or name; prefix beats substring, after T3 Code's `modelPickerSearch.ts`), groups by provider in the source's order (never re-sorted, pi-web #783), the current row marked, rows 44 px on coarse pointers, the list scrolls inside `max-h-available` (never past the viewport), the combobox pattern (the search input with `aria-activedescendant`, a `listbox` of `option` rows with `aria-selected`), keyboard: arrows, Enter, Escape, PageUp/PageDown, Ctrl+Home/Ctrl+End (plain Home/End move the caret of the search input), the search input at 16 px on coarse pointers. Model and provider names are untrusted text (`models.json`, discovery, extensions): clipped and stripped of control, bidi and zero-width characters. States: loading, failed with retry, empty (link to Settings > Models), search with no match, truncated note.
- **Stale value**: a saved model that is no longer offered (provider signed out, switched off) stays visible as "saved, unavailable" at the top, so the form never hides what it will send (the agent form already does this with its `saved` option).
- **Weight**: the field is eager (a few hundred bytes); the list loads on first open through the repo's `useRetryableLazy` and `LazyBoundary`, so a chunk that is gone after a `pap update` or a service-worker update shows "reload the page" and an old shell calling a new daemon (`unknown_method`) is handled the same way. No module-level store: the hook holds its state, so there is nothing to reset at sign-out (MC34), and a test pins it.
- **Where**: agent form, new-lane slots, session menu list. The session menu keeps its dialog, its stars and `sessions.setModel`; only its list is the shared one.

**The `Select` primitive**: `Content` gets `max-h-available` (a new utility from Radix's `--radix-select-content-available-height`, falling back to the app viewport height), scroll-up and scroll-down buttons, and a visible thin scrollbar on the viewport (a rule that beats Radix's injected style). Proven in a real browser: there is no browser CI, so the controller runs the official Playwright container (rootless podman, headless, WebKit and Chromium) on gallery figures, a long `Select` and the picker inside a modal Dialog (plan, controller steps C1 and C2, blocking). The jsdom tests are a guard only: they cannot prove that a list scrolls.

## 5. The provider form (Settings > Models)

Add, edit and remove a provider, writing `models.json` through helper ops (no second store). The raw editor stays for everything the form does not cover.

**Fields** (all of them are fields Pi reads in `models.json`; pap invents none): `id` (the key), `name`, `api` (one of `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, `mistral-conversations`; each is checked to load in Pi's own loader), `baseUrl`, authentication, `headers` (up to 8), `models` (up to 500: `id`, `name`, `reasoning`, `input`, `contextWindow`, `maxTokens`). Models come from discovery (`models.discover`, the owner picks which to import) or by hand. Anything else in the file (a provider's `compat`, `modelOverrides`, `authHeader`, a model's `cost`, `thinkingLevelMap`, `compat`) is preserved untouched and edited in the raw editor; the form says so when a provider carries such fields.

**Authentication** (owner q7): `stored` (the key goes to Pi's `auth.json` through the existing `models.setApiKey`; `models.json` carries no key), `env` (`"apiKey": "$NAME"`), `none` (a local server: the dummy literal Pi needs to count the provider as available), `keep` (edit only: leave `apiKey` as it is, including a `!command` the owner wrote by hand). The form never writes a `!command`; that stays a raw-editor act under its existing step-up.

**Validation at the trust boundary** (zod, `packages/contracts/src/models-provider-form.ts`, plan task 8):

- `baseUrl`: `https:`, or `http:` to a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`) (owner q4); no credentials in the URL, no query, no fragment, at most 2048 characters, no control characters. The `http:` policy is one named constant, `HTTP_PLAINTEXT_POLICY` (`"loopback"` or `"any"`), tested by one table with both verdict columns, so a later flip is one line plus two copy sentences. The red-team argued for `"any"` with a clear-text warning, because the raw editor (same step-up) accepts any URL Pi accepts and loopback-only only sends a LAN Ollama there; the owner kept loopback. The raw editor accepts any URL Pi accepts.
- `id`: `^[a-z0-9][a-z0-9_-]{0,63}$`, never a built-in provider id (the form adds providers; changing a built-in's endpoint is the raw editor's job, owner q9).
- headers: names are HTTP tokens; a header whose name contains a credential word (the shared `credential-words.ts` list) takes only an `$NAME` reference, never a literal (q8); a literal never starts with `!` and never contains `$` (Pi interpolates `$X` and `${X}` in a literal).
- Every refusal comes back as `{ code: "config_invalid", issues: [JSON paths] }` with fixed phrases, never a value.

**Write rules** (helper op, plan task 9). `models.provider.save` takes the revision of `models.json` (the HMAC revision of the editor), re-reads the file inside the Pi write queue, refuses a different revision with `conflict`, and refuses a file that holds comments or trailing commas (strict JSON only: Pi accepts `//` comments and trailing commas, and re-serialising would drop them; the form never rewrites such a file, and `get` answers `editable: false, needs_raw_editor` for every provider of it). It edits `providers[id]` only: the form-owned fields are set or removed, every other key of the provider and of each model is kept; models match by `id`; other providers are untouched. The result is checked with Pi's own loader on a private copy (as `piRejects` does) before the write, written with `writePiFile` (temp file, mode 0600, rename, no hard link), and followed by the existing `enabledModels` resync. A file with an integer of 16 or more digits is refused (JSON round trip would corrupt it).

**Callers.** `models.provider.get` (the form's view of one provider, or with no id just the file's revision for a form that creates; secret-looking literals are `keep` markers, never values; a provider outside the form's grammar, such as a LAN `http:` URL, a query URL, an uppercase id, an odd header or an unknown input kind, answers `editable: false` with a reason and can still be removed: `get` and `remove` take any id the file holds; the `revision` it returns is the save's `baseRevision`), `models.provider.save` and `models.provider.remove`: all `pi:admin` (browser sessions only, a token is `forbidden`), save and remove take the password step-up, get does not. Audit lines `provider_saved {provider}`, `provider_removed {provider}` (ids only). The save's `sensitiveParams` are `id`, `mode` and `baseRevision`, so a replay with the same command id and another target is refused. A key is not set from the provider form: after the save the UI shows the existing key form (`models.setApiKey`, step-up).

**SSRF and key stance** (discover, test). The provider host is the owner's own and may be private (a GPU box on the LAN); this is the opposite of M12's push endpoints, which a browser chooses and which get a DNS guard. What bounds discover and test stays as in M7: browser session only, `pi:admin`, step-up for discover, 15 s, no redirect, no cookie, a status class in the answer, never a body. The new risk is a stolen session repointing a provider that already holds a key at an attacker's host; the save needs the password step-up, which closes it.

**API key handling.** The key travels only in `models.setApiKey`'s params, into Pi's store inside the helper. It is never in `models.json`, a log, a response, an audit detail, a receipt (`sensitiveParams`), `/metrics`, `localStorage` or a URL. The provider form has no key field: the existing `ApiKeyForm` (step-up, empties itself, `autoComplete="off"`, so a browser never offers to save it as a password) is the only place a key is typed. Tests search for a marker key everywhere. An `$NAME` reference can name any variable of the helper's environment, as the raw editor already allows (ADR 0069).

## 6. The availability view

Settings > Models gets an "Available models" section above the provider list.

- **Mode first** (owner q3): "all models of connected providers" (no `enabledModels`, as today; choosing it deletes the current selection and so asks for confirmation) or "my selection" (Pi's `enabledModels`). Per-provider and per-model switches stay what they are (`models.setEnabled`, project or global scope as today, M7R54 to M7R56, M7R65); no new write path, no step-up (M7R133).
- **Preview**: "What your pickers offer", the `models.available` answer grouped by provider with its origin sentence, reloaded after every change. This is the same list the agent form will show.
- **Unconnected providers**: their models show a "not connected" note and are not in the preview, because a model needs a sign-in to be offered (the flag in the overview says only "not switched off").
- **Patterns that match nothing**: listed with a "Clean up" button (the existing `prune` op).
- **Extension providers**: a "Read providers added by extensions" button runs, on the owner's click, the same offline extension load `models.usage` already does and lists the providers and models extensions register, read-only. The pickers outside a session do not include them (owner q5).

## 7. Constraints

400 lines per file; contracts and daemon rules of `AGENTS.md`; UI tokens only; every write has a read path; French copy with vous, per-feature lazy catalogs; no new runtime dependency; initial bundle stays under the 300 KB ceiling (227.4 KB today; this batch adds about 1.5 KB eager, the rest is lazy).

## 8. C, the hook (design only)

A pap-side allow-list ("this person, project or agent may use these models") is a filter over the single source, applied in the daemon after the helper or the worker answers, never inside Pi. `ModelsService.available(caller, { cwd, agentId? })` is already the only entry for no-session contexts, and the daemon already relays `sessions.models` and validates `sessions.setModel`, so one function covers all pickers. The policy narrows Pi's list and never widens it. Storage would be a new table keyed by (subject kind, subject id, provider, model pattern) and a Settings tab; neither is built now. The interface line:

```ts
// future, packages/contracts/src/model-policy.ts: not built in this batch
export interface ModelPolicy { filter(models: readonly ModelSummary[], who: { userId: string; projectId?: string; agentId?: string }): readonly ModelSummary[] }
```

## 9. Risks

- Pi's availability refresh may call the network for an OAuth credential (probe in task 2, with a files-only fallback).
- The strict-JSON rule makes the form refuse a `models.json` with comments or trailing commas, which Pi accepts and a hand-edited file may well have; the owner uses the raw editor then (ruled: never rewrite and drop a comment).
- Loopback-only `http:` (owner q4) sends a LAN server to the raw editor; the policy is a one-line flip.
- A running session is not refreshed (its list is its snapshot); an idle one is, offline.
- Extension models are missing from no-session pickers (a stated difference, not a bug).
- A saved model that Pi no longer offers is still sent on a run and the run fails with Pi's own error; it stays visible as "saved, no longer offered" (owner q6). A run-start check and an agent status warning are a follow-up (not in this batch).
- M6b's backup excludes `models.json`, `auth.json` and `settings.json`: after a restore, providers, the selection and keys are set again (said in `docs/agents/models.md`).
- Two heavy gate slots are shared with M12 and M6b.
