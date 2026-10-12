# ADR 0010 — Collapsible joins the primitives

Status: accepted · Date: 2026-10-11 · Spec: DESIGN.md §9.1 (decision 33: design changes go through an ADR) · Rulings: R53

## Context
DESIGN.md §9.2 needs a disclosure for Reasoning ("▸ thought for 14s", expandable) and for ToolCard's detail levels. §9.1 lists no
primitive for it. Spike S6 (docs/spikes/s6.md, ruling R53) found that every AI Elements component of that kind sits on Radix
Collapsible.

## Decision
`packages/ui` owns a `Collapsible` primitive on Radix Collapsible: a full-width trigger button that owns its look, and a content
region. No animation of the height (state swaps are 0 ms, DESIGN.md §7.2).

## Consequences
Reasoning and ToolCard will use it; callers never restyle the trigger. DESIGN.md §9.1's table gains a "Collapsible" row at the next
DESIGN.md revision.
