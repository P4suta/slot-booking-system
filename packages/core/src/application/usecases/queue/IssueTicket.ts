import type { Temporal } from "@js-temporal/polyfill"
import { Effect } from "effect"
import type { ConcurrencyError, StorageError } from "../../../domain/errors/Errors.js"
import type { Lane } from "../../../domain/queue/Lane.js"
import { nextDisplaySeq, type QueueSnapshot } from "../../../domain/queue/projection.js"
import type { Ticket } from "../../../domain/queue/Ticket.js"
import { applyIssue } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { CustomerHandle } from "../../../domain/value-objects/CustomerHandle.js"
import type { FreeText } from "../../../domain/value-objects/FreeText.js"
import type { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { issueAndPersist } from "../_withUseCaseEnv.js"

export type IssueTicketInput = {
  readonly handle: CustomerHandle
  readonly freeText: FreeText | null
  readonly lane?: Lane
  readonly appointmentAt?: Temporal.Instant | null
}

/**
 * IssueTicket — the FIFO queue's only constructor. Mints a fresh
 * `TicketId`, draws the next monotonic `seq` from the repository,
 * computes the next per-lane `displaySeq` from the current
 * projection (ADR-0065), applies the `Issued` transition (Waiting),
 * and persists the aggregate + event in a single transaction
 * (`repo.issue`).
 *
 * The handle (`nameKana`, `phoneLast4`) is the customer's anonymous
 * credential (ADR-0054); no session, no cookie. The customer keeps
 * the returned `TicketId` to query position and cancel.
 *
 * `lane` defaults to `"walkIn"` when omitted — operators expose the
 * lane choice only on the staff-side issue flow; the customer-facing
 * `/issue` form leaves it blank (ADR-0062).
 *
 * `appointmentAt` defaults to `null` for walk-in / priority tickets;
 * the reservation flow (ADR-0066 / ADR-0068) sets it to the booked
 * slot start instant. The invariant
 * `lane === "reservation" ⇔ appointmentAt !== null` is enforced at
 * the HTTP boundary and pinned by domain property test; this use
 * case forwards whatever the caller supplied.
 */
export const IssueTicket = (
  input: IssueTicketInput,
): Effect.Effect<
  Ticket,
  ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository
    // ADR-0069: handle is the active-set primary key. A second issue
    // with the same `(nameKana, phoneLast4)` while a prior ticket is
    // still active short-circuits to the existing ticket — the
    // customer recovery flow and the "double issue" guard collapse
    // into the same primitive. Lane / appointmentAt / freeText
    // supplied to the merged call are deliberately ignored; the
    // first issue's intent is authoritative until the ticket leaves
    // the active set (Served / Cancelled / NoShow).
    const existing = yield* repo.findActiveByHandle(input.handle)
    if (existing !== null) return existing
    const lane: Lane = input.lane ?? "walkIn"
    const appointmentAt = input.appointmentAt ?? null
    const all = yield* repo.listAll()
    const tickets = new Map<TicketId, Ticket>()
    for (const t of all) tickets.set(t.id, t)
    const snap: QueueSnapshot = { tickets }
    const displaySeq = nextDisplaySeq(snap)
    return yield* issueAndPersist({
      apply: (id, eventId, at, seq) =>
        applyIssue({
          id,
          seq,
          lane,
          displaySeq,
          nameKana: input.handle.nameKana,
          phoneLast4: input.handle.phoneLast4,
          freeText: input.freeText,
          appointmentAt,
          at,
          eventId,
        }),
      log: ({ id, seq }) => ({
        tag: "IssueTicket",
        code: "I_USECASE_ISSUE_TICKET",
        data: { ticketId: id, seq, lane, displaySeq },
      }),
    })
  })
