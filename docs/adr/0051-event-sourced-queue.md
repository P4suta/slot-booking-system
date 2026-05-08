# ADR-0051: Event-sourced queue projection

- Status: Accepted
- Date: 2026-05-08
- Refines: ADR-0029 (event-sourced repository, slot-graph era)

## Decision

The queue's truth is the totally-ordered sequence of `TicketEvent`s
(`Issued` / `Called` / `Served` / `NoShowed` / `Cancelled`). The
`Ticket` aggregate is the left fold:

```text
replay : ReadonlyArray<TicketEvent> → QueueSnapshot
replay = events.reduce(applyEvent, empty)
```

The fold is a **monoid homomorphism** over the free monoid on events:

```text
replay(xs ++ ys) ≡ applyMany(replay(xs), ys)
```

This law is pinned by `packages/core/test/domain/queue/projection.test.ts`.

`QueueSnapshot` carries `tickets: ReadonlyMap<TicketId, Ticket>`; the
derived queries `head`, `serving`, `positionOf`, and `waitingCount`
are `O(N≤200)` walks (the Iron-Principles scale target is ≤10
concurrent users). Should a deployment grow past that, the
recommended migration is to maintain a `seq_counter` row in the
`Issued`/`Called` event transaction and reduce position to
`mySeq − servedSeq`.

## Consequences

- `Ticket` is constructed exclusively by `applyIssue`; subsequent
  transitions are all in-place projections.
- `applyEvent` ignores no-op events (e.g. `Called` against a non-
  `Waiting` ticket) so the projection stays self-consistent under
  re-plays of partial logs.
- The append-only log mirror in D1 (`ticket_events`) is the long-
  term audit surface; the DO's local SQLite is the canonical write
  side, drained via outbox.
