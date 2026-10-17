# ADR 0060: delivery rules, quiet hours, the digest and generic payloads

Status: accepted (M12, Tasks 8 to 12)
Date: 2026-10-17
Spec: C 6.2 and 6.4, D17. Rulings: M12R1 to M12R3, M12R7, M12R13, M12R17, M12R22, M12R23, W6-R3, W6-R4, W6-R6, W6-R7, W6-R10, W6-R11.

## Decision

Every source calls one notifier, which writes the event and the `push.send` outbox effect in one transaction (approvals at +60 s). A pure `decide()` orders class, mute, presence, cooldown, hourly cap (approvals and the digest exempt) and quiet hours. The handler re-judges at send time and delivers per device with up to 5 attempts; it never marks the effect sent, so a crash can repeat a push and `Topic` plus `tag` collapse it, which is better than a lost approval. Held events become one digest push at the end of the quiet window, counting items still waiting and requests that expired meanwhile. The wire text is generic ("pap" and a fixed sentence per class) with an opaque 22-character id; an off-by-default option appends a name taken only from the trigger or agent registry. Details are fetched after the click through `push.open`. Session approvals come from the attention feed (one push per waiting session, a child's dialog on the parent's card); Inbox approvals survive a restart; budgets push when reached, once per scope per zone day.

## Alternatives

At-most-once delivery (a lost approval); the question text on the lock screen (untrusted agent text); one push per Inbox row regardless of the session (duplicates).

## Consequences

Possible duplicate pushes after a crash; a mid-day zone change can give a second budget push; no push for a failed feed poll or trigger-level effect (M12-RT-32). `last_failure` is kept per owner.
