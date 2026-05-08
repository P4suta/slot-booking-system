import { Effect } from "effect"
import type { DomainError } from "../../../domain/errors/Errors.js"
import type { Ticket } from "../../../domain/queue/Ticket.js"
import { applyIssue } from "../../../domain/queue/transitions.js"
import type { CustomerHandle } from "../../../domain/value-objects/CustomerHandle.js"
import type { FreeText } from "../../../domain/value-objects/FreeText.js"
import { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import { IdGenerator } from "../../ports/IdGenerator.js"
import { Logger } from "../../ports/Logger.js"
import { infoPayload } from "../_log.js"

export type IssueTicketInput = {
  readonly handle: CustomerHandle
  readonly freeText: FreeText | null
}

/**
 * IssueTicket — the FIFO queue's only constructor. Mints a fresh
 * `TicketId`, draws the next monotonic `seq` from the repository,
 * applies the `Issued` transition (Waiting), and persists the
 * aggregate + event in a single transaction (`repo.issue`).
 *
 * The handle (`nameKana`, `phoneLast4`) is the customer's anonymous
 * credential (ADR-0054); no session, no cookie. The customer keeps
 * the returned `TicketId` to query position and cancel.
 */
export const IssueTicket = (
  input: IssueTicketInput,
): Effect.Effect<Ticket, DomainError, Clock | IdGenerator | TicketRepository | Logger> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const idgen = yield* IdGenerator
    const repo = yield* TicketRepository
    const logger = yield* Logger
    const id = yield* idgen.newTicketId
    const eventId = yield* idgen.newTicketEventId
    const seq = yield* repo.nextSeq()
    const at = yield* clock.nowInstant
    const r = applyIssue({
      id,
      seq,
      nameKana: input.handle.nameKana,
      phoneLast4: input.handle.phoneLast4,
      freeText: input.freeText,
      at,
      eventId,
    })
    if (r._tag === "Failure") return yield* Effect.fail(r.failure)
    yield* repo.issue(id, [r.success.event], r.success.ticket)
    yield* logger.info(
      infoPayload("IssueTicket", "I_USECASE_ISSUE_TICKET", {
        ticketId: id,
        seq,
      }),
    )
    return r.success.ticket
  })
