# ADR 0070: the availability view, extension providers, and the policy hook

Status: accepted (models batch, chain B)
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

- Extension models appear in a session's model menu and in this read-only list, not in the agent form or the new-lane picker; the picker footnote says so.
- A trust change reaches the pickers within the 10 s cache TTL; the `trust` module is not wired to the cache.
- The saved choice that a switch hides stays visible in the pickers as "saved, no longer offered" (MPR5); no run-start check exists, a follow-up.
