# ADR 0075: the spec D cutover is out of scope for v1

Status: accepted · Date: 2026-10-18 · Spec: `docs/specs/2026-10-10-D-clean-start.md` sections 1 and 2. Rulings: M13R56, M13R17, M13R52; owner q12.

This ADR records a deviation from spec D: its cutover steps 2 to 4 (recreate, stop pi-web with port takeover, clean-up) and the section 1 rule 5 rollback text are out of scope for v1. **pap does not replace pi-web.** The owner answered q12 with "Osef de pi-web on tente pas de le remplacer".

## Context

Spec D planned a cutover that would move the owner from pi-web to pap. The owner decided on 2026-10-18 that pap will not try to replace pi-web. The two apps run side by side on the same machine and share the Pi folder `~/.pi/agent`.

## Decision

- No cutover runbook (`cutover.md`, `cutover-doc.test.ts`), no port takeover, no pi-web freeze steps beyond "never modify pi-web". Nothing in M13 touches pi-web or its service.
- Kept: the live outside-write warning (ADR 0074); the int test that pap never reads pi-web's files; the coexistence note in `docs/agents/sessions.md`, with its rule "never resume one session in both apps".
- The preview keeps its run mode (checkout unit, LAN IP, `--insecure-http`, ADR 0004). HTTP on the LAN stays a documented testing option (q13).
- The q17 condition "cutover done on your machine" drops: v1.0.0 follows the public repository with green CI.
- Spec D section 1 rule 1 still holds: pap never imported pi-web data, so the data model needs no change if a later milestone writes the runbook.

## Consequences

Cost if wrong: a later milestone writes the cutover runbook. This ADR reuses the number planned for the cutover record.
