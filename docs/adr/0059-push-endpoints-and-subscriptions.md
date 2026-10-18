# ADR 0059: push endpoints, the host list and per-device browser-only subscriptions

Status: accepted (M12, Tasks 2, 4, 5 and 7)
Date: 2026-10-17
Spec: C 3, D17. Rulings: M12R8 to M12R10, M12R12, M12R20, M12-RT-19.

## Decision

A subscription endpoint is accepted only as `https:` on port 443 without credentials, fragment, IP literal or empty label, at most 2048 characters, and only for the built-in push hosts (Apple, Google FCM, Mozilla, Microsoft) plus at most 8 exact names from `PAP_PUSH_EXTRA_HOSTS`; there is no switch to turn the list off. The sender re-checks the rules at send time and connects through a guarded lookup: every DNS answer must pass `blockedForPush` and the socket uses the checked address; no redirects. `blockedForPush` is `blockedAddress` (moved unchanged to `kernel/net/address.ts`) plus Teredo, documentation and discard IPv6 ranges and the IPv4 documentation and 6to4 relay blocks. Subscriptions belong to one owner and one browser session (`credential_id`); only a browser session may subscribe, list, revoke, test or report presence (a token gets `forbidden` before any read). The endpoint is stored with its hash; logs and `push.list` carry the hash or the host only. At most 10 per owner; a full cap refuses and never evicts. A signed-out or expired credential gets nothing sent and its row is deleted; 404/410 delete the row.

## Alternatives

Any https host (SSRF with a browser-chosen URL); a list-off switch (a mistake would be silent); widening `blockedAddress` itself (M11's egress tests use 198.51.100.x and 203.0.113.x as public fixtures).

## Consequences

A new push vendor needs `PAP_PUSH_EXTRA_HOSTS`. Three address checks remain (`blockedAddress`, `blockedForPush`, `automation/net-guard.ts`); merging them and hardening the egress proxy with the extra ranges is left for the M13 sweep.

M13 (R14, R46): `blockedForPush` is renamed `blockedStrict` (`kernel/net/address-strict.ts`) and the egress proxy uses it too; three predicates remain (`blockedAddress`, `blockedStrict`, `automation/net-guard.ts`), compared by a table test.

Criterion (M13-C5): `blockedStrict` refuses every more-specific IANA special-purpose block marked not globally reachable; the unassigned remainder of 2001::/23 is unrouted and stays open, plus the mapped, SIIT and 6to4 forms of a refused IPv4 address; so 3fff::/20, 2001:2::/48, 2001:10::/28 and 5f00::/16 are added, while 2001:20::/28 (ORCHIDv2, globally reachable) stays allowed.
