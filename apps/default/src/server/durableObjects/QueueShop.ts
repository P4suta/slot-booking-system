import { DurableObject } from "cloudflare:workers"
import {
  CallNext,
  CancelTicket,
  type CustomerHandle,
  IssueTicket,
  MarkNoShow,
  MarkServed,
  SystemClockLive,
  type Ticket,
  type TicketId,
  UlidIdGeneratorLive,
} from "@booking/core"
import { Effect, Layer } from "effect"
import { DurableObjectTicketRepositoryLive } from "../adapters/DurableObjectTicketRepositoryLive.js"
import { WorkersLoggerLive } from "../adapters/WorkersLoggerLive.js"
import { ensureDurableObjectSchema } from "./schema.js"

type Env = {
  DB: D1Database
  NO_SHOW_TIMEOUT_SECONDS?: string
}

/**
 * Action dispatched by the worker to the single QueueShop instance.
 * Discriminated union over the five use cases; the DO routes each
 * action through the matching `application/usecases/queue/` entry
 * point. Phase 3 swaps this raw envelope for an Effect-RPC-typed
 * channel; the action shape is the wire contract either way.
 */
export type QueueAction =
  | { type: "IssueTicket"; handle: CustomerHandle; freeText: string | null }
  | { type: "CallNext"; actor: "staff" | "system" }
  | { type: "MarkServed"; ticketId: TicketId }
  | { type: "MarkNoShow"; ticketId: TicketId; actor: "staff" | "system" }
  | {
      type: "CancelTicket"
      ticketId: TicketId
      actor: "customer" | "staff"
      reason: string
      handle?: CustomerHandle
    }

export type QueueResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; error: { _tag: string; code: string } }

const NO_SHOW_TIMEOUT_DEFAULT_SECONDS = 300

/**
 * QueueShop — the single-writer Durable Object actor (ADR-0053).
 * One instance per deployment, keyed by `idFromName("shop")`. The
 * actor model serialises every concurrent write so the FIFO queue
 * is consistent without locks; the DO's local SQLite is the
 * canonical event log + projection.
 *
 * Phase 2 wires the dispatch entry point through plain `dispatch`
 * RPC; Phase 3 layers an Effect-RPC-typed channel on top. The alarm
 * tick fires the no-show sweep (`Called` tickets older than
 * `NO_SHOW_TIMEOUT_SECONDS` → `NoShow`). The outbox drain to D1 is
 * scheduled by the same alarm.
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
        case "CancelTicket":
          return CancelTicket(action.ticketId, action.actor, action.reason, action.handle)
      }
    })()
    return Effect.runPromise(
      Effect.matchEffect(eff, {
        onSuccess: (ticket) => Effect.succeed({ ok: true, ticket } satisfies QueueResult),
        onFailure: (err: unknown) =>
          Effect.succeed({
            ok: false,
            error: {
              _tag: (err as { _tag?: string })._tag ?? "Unknown",
              code: (err as { code?: string }).code ?? "E_UNKNOWN",
            },
          } satisfies QueueResult),
      }).pipe(Effect.provide(layer)),
    )
  }

  async listTickets(): Promise<readonly Ticket[]> {
    const rows = this.sql.exec("SELECT id, state FROM tickets").toArray()
    return rows.map((r) => ({ id: r.id, state: r.state }) as unknown as Ticket)
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
