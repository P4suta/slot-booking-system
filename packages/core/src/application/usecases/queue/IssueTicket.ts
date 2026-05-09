import type { Effect } from "effect"
import type { ConcurrencyError, StorageError } from "../../../domain/errors/Errors.js"
import type { Ticket } from "../../../domain/queue/Ticket.js"
import { applyIssue } from "../../../domain/queue/transitions.js"
import type { CustomerHandle } from "../../../domain/value-objects/CustomerHandle.js"
import type { FreeText } from "../../../domain/value-objects/FreeText.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { issueAndPersist } from "../_withUseCaseEnv.js"

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
): Effect.Effect<
  Ticket,
  ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  issueAndPersist({
    apply: (id, eventId, at, seq) =>
      applyIssue({
        id,
        seq,
        nameKana: input.handle.nameKana,
        phoneLast4: input.handle.phoneLast4,
        freeText: input.freeText,
        at,
        eventId,
      }),
    log: ({ id, seq }) => ({
      tag: "IssueTicket",
      code: "I_USECASE_ISSUE_TICKET",
      data: { ticketId: id, seq },
    }),
  })
