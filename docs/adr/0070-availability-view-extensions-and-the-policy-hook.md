# ADR 0070: the availability view, extension providers, and the policy hook

Status: accepted (models batch, chain B; amended 2026-10-18: extension models in the no-session pickers)
Date: 2026-10-17
Spec: `docs/specs/2026-10-17-models-picker-providers-design.md` (the availability view, and section 8, the hook). ADR 0068 (one source), ADR 0069 (the provider form). Rulings: MPR16, MPR17, MPR18, MPR-C8 in `docs/research/models-batch-rulings.md`.

## Decision

**Availability view (Settings › Models › Available models, MPR16).** The mode comes first ("All the models of the connected providers" or "My selection"), then a switch per provider and model, then a preview. It writes only through `models.setEnabled` (no step-up, M7R133) and previews only with `models.available`, the call every picker makes, so the preview is the list a picker would show, never a list derived from the switches. A provider that is not connected still has switches and says "not connected"; its models are offered once the provider is. Patterns that match nothing are listed with a Clean up button (`prune`). Choosing "All models" calls `clear`, which deletes the owner's saved list with no undo, patterns for providers not signed in right now included, so it asks first and names the number of entries it removes. A project selection (a trusted project's `.pi/settings.json`) is shown as text with the file path and read-only switches. After each write the overview and the preview are read again; the two reads are deliberate (the first is dropped as outdated when the second starts, and the helper runs at most one at a time, with one trailing read).

**Extension providers (MPR17, MPR-C8).** A read-only list loaded on a click through the helper op `models.extensions`, which runs the owner's global extensions the way `models.usage` does (global only, no project scope, `projectTrusted: false` and a trust resolver that answers no, offline flag on). Built-in ids are left out, so are providers of `models.json`; an extension that re-registers a `models.json` provider is listed and marked "overrides". No base URL, header or key is read. The copy never claims the load has no network: Pi's offline flag stops Pi's installs and refresh, not an extension's own fetch. The list carries `truncated` (provider cap, byte budget, over-long provider id) and `modelsTruncated` per provider (500 models, byte budget, a model id over 256 characters). The helper's `getRegisteredProviderIds` is the source, so a provider an extension registers only when an event fires, in a live session, is not listed.

**The C hook, design only (MPR18, owner q11).** Restrictions per person, project or agent come after v1; nothing of them is in the UI or the code. A pap-side allow-list would be a filter over the single source (ADR 0068), applied in the daemon after the helper or the worker answered, never inside Pi; `ModelsService.available(caller, { cwd, agentId? })` is already the one entry for no-session contexts, and the daemon already relays `sessions.models` and validates `sessions.setModel`. The policy narrows Pi's list and never widens it. Storage would be a new table keyed by (subject kind, subject id, provider, model pattern) and a Settings tab. The interface line, not built:

```ts
// future, packages/contracts/src/model-policy.ts: not built in this batch
export interface ModelPolicy { filter(models: readonly ModelSummary[], who: { userId: string; projectId?: string; agentId?: string }): readonly ModelSummary[] }
```

## Alternatives rejected

- **Derive the preview from the overview's switches.** It would be a second list, the drift ADR 0068 removed.
- **Show extension models in every picker.** The no-session helper loads no extension code; running it on every picker open is the owner's click, not a default (MC52).
- **Build the policy now.** The owner asked for the hook as a paragraph (q11).

## Consequences

- Extension models appear in a session's model menu and in this read-only list, not in the agent form or the new-lane picker; the picker footnote says so. *(Replaced by the amendment below: the pickers list them on their own click.)*
- A trust change reaches the pickers within the 10 s cache TTL; the `trust` module is not wired to the cache.
- The saved choice that a switch hides stays visible in the pickers as "saved, no longer offered" (MPR5); no run-start check exists, a follow-up. *(Amended: a refused agent model is said in its session.)*

## Amendment (2026-10-18): extension models in the no-session pickers

The owner asked to choose pi-claude-bridge's models for agents. The consent model does not change: extension code runs only on a click, through the same `pi:admin` op, and the daemon keeps nothing.

- **The click moves into the pickers too.** Under the list of the agent form's and the new-lane dialog's picker, "Show models added by extensions" calls `models.extensions`. Its models join the list in a group per provider, marked "from an extension"; picking one stores `{provider, modelId}` like any other. This replaces the first consequence above ("not in the agent form or the new-lane picker") and narrows the rejected alternative: still never on a picker's open, now on its own click.
- **`offered` per model.** The op marks each model with what Pi's one rule (ADR 0068, `listAvailable`) says over the same load, with the global selection and no project. The pickers list offered models only, so they never offer a model an agent's worker would refuse at `set_model` (a refused model leaves the thread on another model), except for an agent in Chat only, whose worker loads no extension: its form's picker hides the extension part and says so, and the refusal of a model whose provider the worker lacks has a notice of its own (`agent_model_refused_chat`; a model of Pi's own providers keeps the regular one). Settings lists them all and marks the others "not offered". The contract gains one boolean per model row.
- **One answer per tab.** The web keeps the last answer in one store shared by Settings and the pickers (`features/models/extension-read.ts`): reopening runs nothing, "Read again" reads again, a sign-out forgets it.
- **One helper per read, pinned.** pi-claude-bridge registers at load only in the first instance of its module in a process. The helper pool already forks one process per call; a fixture with that rule (`packages/pi-host/src/testing/bridge-like-extension.mjs`) and two reads in a row through a real pool pin it (`apps/daemon/src/modules/models/extensions.int.test.ts`).

- **"My selection" names an extension's models** (fix round, same day). Once read, each extension provider and model gets the switches of the others and the same `models.setEnabled` ops (no step-up, M7R133). The helper plans over its runtime without extensions unless that runtime cannot plan the edit without losing an extension's model: an op naming a model or provider it lacks, an entry it cannot judge that the edit would rewrite or fold, leaving "All the models" (every model listed from no list), a "last model" while such an entry remains, or a list it matches nowhere. Only then does a write load the owner's global extensions, the way `models.extensions` does; the list is read again after the load, and a failed load writes nothing (`extensions_failed`). Each of these is a switch the owner clicked, so the consent is the same. After any write of Pi's files, from this view or another Settings page, an answer read in this tab is read again so its marks stay true, and the daemon never lets that read join a run that started before the write.
- **Clean up keeps what it cannot judge.** `prune` removes an entry that matches nothing only when it names a provider known without extensions (`cleanUpJudges`, one rule in the contracts for the helper and the web). An extension's entry (`claude-bridge/x`), a glob or a bare id stays, marked in Settings; the button shows only when an entry would go.
- **A refused agent model is said in the session.** When an agent's worker refuses the saved model, the session gets a warning notice (`agent_model_refused`, the saved model and the one that runs, with the way to Settings › Models › Available models; `agent_model_refused_chat` in Chat only for a provider the worker lacks; `agent_model_not_applied` when the change failed otherwise), kept for a later tab's snapshot. A picker field that learned its value is not offered keeps a line under it, without blocking a save.

Residuals are in `docs/agents/models.md` (Residuals, models batch): a selection made only of extension entries reads as "every model" without extensions, Clean up never removes an entry it cannot judge (a typo of a provider name included), a lane's project selection that the mark ignores, the not-offered line that appears only once the picker was opened, and a switch that may load the extensions (leaving "All the models" always does).
