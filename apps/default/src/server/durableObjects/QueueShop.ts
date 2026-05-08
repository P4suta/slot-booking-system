import { DurableObject } from "cloudflare:workers"
import {
  CallNext,
  CancelTicket,
  type CustomerHandle,
  codeOf,
  IssueTicket,
  MarkNoShow,
  MarkServed,
  Recall,
  SystemClockLive,
  type Ticket,
  type TicketId,
  TicketSchema,
  UlidIdGeneratorLive,
} from "@booking/core"
import { Cause, Effect, Layer, Schema } from "effect"
import { DurableObjectTicketRepositoryLive } from "../adapters/DurableObjectTicketRepositoryLive.js"
import { WorkersLoggerLive } from "../adapters/WorkersLoggerLive.js"
import { ensureDurableObjectSchema } from "./schema.js"

type Env = {
  DB: D1Database
  NO_SHOW_TIMEOUT_SECONDS?: string
}

/**
 * Action dispatched by the worker to the single QueueShop instance.
 * Discriminated union over the use cases; the DO routes each action
 * through the matching `application/usecases/queue/` entry point.
 */
export type QueueAction =
  | { type: "IssueTicket"; handle: CustomerHandle; freeText: string | null }
  | { type: "CallNext"; actor: "staff" | "system" }
  | { type: "MarkServed"; ticketId: TicketId }
  | { type: "MarkNoShow"; ticketId: TicketId; actor: "staff" | "system" }
  | { type: "Recall"; ticketId: TicketId; actor: "staff" | "system" }
  | {
      type: "CancelTicket"
      ticketId: TicketId
      actor: "customer" | "staff"
      reason: string
      handle?: CustomerHandle
    }

/**
 * The Worker boundary serialises every DO RPC return through
 * `structuredClone`, which rejects `Temporal.Instant` values (no
 * default cloner). We re-encode the ticket via `Schema.encode` so the
 * wire shape is JSON-safe; consumers re-decode if they need typed
 * Temporal access.
 */
export type EncodedTicket = (typeof TicketSchema)["Encoded"]

export type QueueResult =
  | { ok: true; ticket: EncodedTicket }
  | { ok: false; error: { _tag: string; code: string } }

const encodeTicket = (t: Ticket): EncodedTicket => Schema.encodeUnknownSync(TicketSchema)(t)

const NO_SHOW_TIMEOUT_DEFAULT_SECONDS = 300

/**
 * QueueShop — the single-writer Durable Object actor (ADR-0053).
 * One instance per deployment, keyed by `idFromName("shop")`. The
 * actor model serialises every concurrent write so the FIFO queue
 * is consistent without locks; the DO's local SQLite is the
 * canonical event log + projection. The alarm tick fires the no-show
 * sweep (`Called` tickets older than `NO_SHOW_TIMEOUT_SECONDS` →
 * `NoShow`) and drains the outbox to D1.
 */
export class QueueShop extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.sql = state.storage.sql
    state.blockConcurrencyWhile(async () => {
      ensureDurableObjectSchema(this.sql)
    })
  }

  private layer() {
    const repo = DurableObjectTicketRepositoryLive(this.sql)
    return Layer.mergeAll(SystemClockLive, UlidIdGeneratorLive, repo, WorkersLoggerLive)
  }

  async dispatch(action: QueueAction): Promise<QueueResult> {
    const layer = this.layer()
    const eff = (() => {
      switch (action.type) {
        case "IssueTicket":
          return IssueTicket({
            handle: action.handle,
            freeText: action.freeText as Ticket["freeText"],
          })
        case "CallNext":
          return CallNext(action.actor)
        case "MarkServed":
          return MarkServed(action.ticketId)
        case "MarkNoShow":
          return MarkNoShow(action.ticketId, action.actor)
        case "Recall":
          return Recall(action.ticketId, action.actor)
        case "CancelTicket":
          return CancelTicket(action.ticketId, action.actor, action.reason, action.handle)
      }
    })()
    return Effect.runPromise(
      Effect.matchCauseEffect(eff, {
        onSuccess: (ticket) =>
          Effect.succeed({ ok: true, ticket: encodeTicket(ticket) } satisfies QueueResult),
        onFailure: (cause) => {
          console.error("[QueueShop] dispatch cause:", cause)
          const fails = cause.reasons.filter(Cause.isFailReason)
          const first = fails[0]?.error
          if (first?._tag === "Storage") {
            console.error("[QueueShop] Storage reason:", first.reason, "cause:", first.cause)
          }
          return Effect.succeed({
            ok: false,
            error: {
              _tag: first?._tag ?? "Defect",
              code: first !== undefined ? codeOf(first) : "E_DEFECT",
            },
          } satisfies QueueResult)
        },
      }).pipe(Effect.provide(layer)),
    )
  }

  /**
   * Read the full ticket projection. Returns the encoded shape (JSON-
   * safe) so the worker can pass it back over the structuredClone
   * boundary without DataCloneError.
   */
  async listTickets(): Promise<readonly EncodedTicket[]> {
    const rows = this.sql.exec("SELECT payload FROM tickets ORDER BY seq ASC").toArray()
    return rows.map((r) => JSON.parse(r.payload as string) as EncodedTicket)
  }

  override async alarm(): Promise<void> {
    const timeoutSeconds = Number(
      this.env.NO_SHOW_TIMEOUT_SECONDS ?? NO_SHOW_TIMEOUT_DEFAULT_SECONDS,
    )
    const cutoff = new Date(Date.now() - timeoutSeconds * 1000).toISOString()
    const stale = this.sql
      .exec("SELECT id FROM tickets WHERE state = 'Called' AND called_at <= ?", cutoff)
      .toArray()
    for (const row of stale) {
      await this.dispatch({
        type: "MarkNoShow",
        ticketId: row.id as TicketId,
        actor: "system",
      })
    }
  }
}
