# ADR-0070: Reservation reschedule — atomic appointmentAt swap

- Status: Accepted
- Date: 2026-05-11
- Refines: ADR-0066 (slot value object), ADR-0067 (time-aware lane
  chain), ADR-0068 (unified issue flow), ADR-0069 (handle as
  active-set primary key)

## Decision

A reservation customer who entered the wrong appointment time can
change **only** the `appointmentAt` field of their ticket, in
place, via a single atomic transition. The ticket id, seq,
displaySeq, lane, handle, and freeText all remain the same. The
event log gains one `Rescheduled` variant:

```ts
Rescheduled = {
  type: "Rescheduled"
  from: Instant
  to:   Instant
  rescheduledBy: Actor   // "customer" | { staff: StaffActorId }
}
```

The transition is exposed at three layers:

1. **core** — `applyReschedule(t, newAt, ...): ApplyResult` accepts
   any ticket in `{ Waiting, Called, Serving }` whose lane is
   `"reservation"`. The new slot's occupancy is computed via
   `occupancyExcludingSelf(snap, t.id, newSlot, tz)` so swapping
   to the **same** slot is a no-op success (event suppressed)
   rather than a `SlotFull` rejection.
2. **default** — `POST /api/v1/tickets/:id/reschedule` accepts
   either path:
   - **Customer**: body carries `{ nameKana, phoneLast4,
     newAppointmentAt }`. The server compares the handle
     constant-time against the stored ticket (ADR-0058 / ADR-0069)
     and rejects mismatches with `403 PhoneMismatch`. Throttled
     by `RL_VERIFY` (30 / min / IP).
   - **Staff**: body carries `{ newAppointmentAt }`. The
     `x-staff-token` header is the auth gate (ADR-0058).
3. **web** — `/ticket` grows a "予約時刻を変更" button (visible iff
   the ticket is reservation-laned and active) opening a Dialog
   that pre-selects the current appointmentAt in `SlotPicker` and
   prefills the handle from the localStorage cache (ADR-0069).

Other ticket fields (handle, lane, freeText) **cannot** be edited
on a live ticket. A customer who wants to fix their kana or
phone digits is told to cancel and re-issue. This keeps the
domain narrow — `applyReschedule` is a pure projection over
`appointmentAt`, not a generic update.

## Context

Stage 12 of the time-axis sprint observed that mistyped
appointment times had no recovery path other than cancel +
re-issue. Between cancelling and re-issuing the customer's slot
is released back to the pool, so on a busy lane the new
appointment can land later — strictly worse than the original
mistake.

The set of edits actually requested in practice is small:

| Field          | Customer says | Frequency |
|----------------|----------------|-----------|
| appointmentAt  | "I meant 14:00, not 15:00" | common |
| nameKana       | "I typed a typo in my name" | very rare |
| phoneLast4     | "I typed my partner's last 4" | very rare |
| freeText       | "I want to add a note" | very rare |

The cost of a generic patch endpoint is high (more attack surface,
more fields to validate, more state-transition cases) while the
benefit is concentrated on appointmentAt. Cancelling and
re-issuing covers the rare cases without forcing the design to
carry a per-field update matrix.

The other natural concern is whether to allow reschedule from
`Called` or `Serving`. We do — operationally a staff member
might call a reservation customer up early and then realise the
appointment was filed against the wrong slot. Rolling back to
`Waiting` for the swap would require additional state-machine
plumbing; the simpler choice is to keep the lifecycle untouched
and apply the swap in place. The `from` / `to` audit trail
records the intent regardless of state.

## Trade-offs

| | Reschedule (ADR-0070) | Cancel + re-issue |
|--|--|--|
| Preserves seq / displaySeq | yes | no (new ticket id) |
| Preserves position in lane | yes | no (back of queue) |
| Customer keeps notifications | yes | no (new ticketId) |
| Slot held atomically | yes (occupancyExcludingSelf) | no (race window) |
| Edits other fields | no | yes |
| Audit row | `Rescheduled` event | `Cancelled` + `Issued` |

**Same-slot reschedule is a no-op success, not 409.** Submitting
the current appointmentAt returns 200 with the unchanged ticket.
This is symmetric with `IssueTicket`'s idempotent merge
(ADR-0069) — the operator/customer's intent ("be at this time")
is satisfied, so the protocol does not reject for "you didn't
change anything".

**Stale snapshot guard.** Because the customer is comparing a
human-readable "あと N 分" countdown against the new slot, the
web layer rejects an unchanged selection (`newSlotISO ===
ticket.appointmentAt`) at the button. The server treats it as
the no-op success path even if the button check leaks through.

**Customer-initiated reschedule rate.** RL_VERIFY (30 / min /
IP) is the same gate as `IssueTicket` and `ticketByHandle` —
brute-forcing slot availability through reschedule attempts is
no faster than the existing handle-enumeration oracle (ADR-0069
§Trade-offs).

**Staff path: token + body only.** The staff path is a single
explicit decision per call; no audit-trail-only "as customer"
flag (= would let a staff user impersonate a customer in the
audit log). The `Rescheduled.rescheduledBy` discriminator
encodes the actor at the transition site.

## Implementation

- `packages/core/src/domain/queue/events.ts` — `RescheduledEvent`
  variant + Schema.
- `packages/core/src/domain/queue/transitions.ts` —
  `applyReschedule(t, newAt, at, eventId, rescheduledBy)` returns
  `ApplyResult` with the new transitions `SlotFull` /
  `SlotInPast` / `LaneMismatch` covered.
- `packages/core/src/domain/queue/projection.ts` —
  `occupancyExcludingSelf(snap, ticketId, slot, tz)` helper.
- `packages/core/src/application/usecases/queue/RescheduleTicket.ts`
  — usecase that validates the handle, looks up the ticket,
  applies the transition, persists.
- `apps/default/src/server/durableObjects/QueueShop.ts` — adds
  `RescheduleTicket` action; broadcasts the updated projection on
  success.
- `apps/default/src/server/http/router.ts` —
  `POST /api/v1/tickets/:id/reschedule`, `RescheduleBodySchema`,
  customer / staff path branching.
- `apps/default/wrangler.toml` — `DEPLOYMENT_TIMEZONE = "Asia/Tokyo"`
  is the safety default for the bucket-of-now computation; the
  router falls back to the same string if the binding is missing
  (ADR-0066 §Implementation pinned `tz` to the slot-occupancy
  computation; reschedule re-uses the same fallback).
- `apps/web/src/lib/api.ts` — `rescheduleTicket(ticketId, body)`.
- `apps/web/src/lib/components/SlotPicker.svelte` — extracted from
  `/issue` so the reschedule Dialog can re-use the date-tab + 30-min
  grid (`apps/web/src/lib/slotTime.ts` carries the bucket
  arithmetic).
- `apps/web/src/routes/ticket/+page.svelte` — reservation Card
  grows a "予約時刻を変更" button + Dialog (Stage 12 web A-3);
  handle prefill from `ticketCache` (Stage 5 / Stage 8 cache).

## §UX (customer playbook)

```text
/ticket
  └ 予約カード
      ├ 「予約時刻: 14:00」 (現)
      ├ 「あと X 分」 / 「時間です」 / 到着済バッジ
      ├ [到着しました]                ← Waiting + check-in window 内
      └ [予約時刻を変更]              ← reservation && active
          └ Dialog
              ├ 「現在の予約時刻: 14:00」
              ├ 確認文 (confirm_reschedule_body)
              ├ <SlotPicker> ← 現枠が pre-selected
              ├ [戻る]
              └ [この時間に変更する]   ← 別 slot 選択時のみ enabled
```

Error flows in the Dialog:

| 状況 | 表示 |
|--|--|
| 同じ slot をもう一度選んで送信 | button disabled (= 送信させない) |
| 別 slot を選んで満席 | inline ErrorCard 「選択した時間枠は満席です…」 |
| 別 slot を選んで過去時刻 | inline ErrorCard 「過去の時間は選択できません」 |
| handle 不一致 (cache 壊れ等) | inline ErrorCard 「お名前または電話番号末尾 4 桁が一致しません」 |
| ticket 取り消し後の再 dialog | inline ErrorCard 「整理券が見つかりませんでした」 + Dialog 自閉 |

Recovery: the Dialog never blocks the page; the customer can
"戻る" at any point. Successful swap calls `refresh()` so the
appointment Card's countdown re-reads the new slot without
waiting for the next WS broadcast.

## Consequences

- The active-set primary key from ADR-0069 stays intact —
  reschedule never changes the handle, so the
  `(name_kana, phone_last4) WHERE state ∈ active` UNIQUE index
  is undisturbed.
- The Slot occupancy monoid (ADR-0066) gains an *exclude-self*
  consumer; the helper is the only place where occupancy can
  validly count "everyone but me". A property test pins the
  invariant `occupancy(slot) ≡ occupancyExcludingSelf(t, slot) +
  [t in slot]`.
- The audit trail now distinguishes a customer-initiated
  reschedule from a staff-initiated one. Operator reports that
  ask "how often do customers self-correct" can be answered from
  the event log without joining external sources.
- `/staff` does not yet offer a reschedule button. The backend
  endpoint accepts staff path so a future sprint can wire the
  terminal without further router work. Out of scope for this
  ADR.
- Sharing a short-lived capability for "let a coordinator change
  another customer's slot" is intentionally not introduced. The
  potential misuse surface (= one customer reschedules another's
  ticket via guessed handle) exists at RL_VERIFY rate and is
  the same oracle as ADR-0069's enumeration.

## References

- ADR-0066 — slot value object + appointmentAt encoding.
- ADR-0067 — time-aware lane chain.
- ADR-0068 — unified `/issue` flow.
- ADR-0069 — handle as active-set primary key + localStorage cache.
- ADR-0058 — timing-safe handle equality (re-used for staff
  token compare + customer handle compare).
