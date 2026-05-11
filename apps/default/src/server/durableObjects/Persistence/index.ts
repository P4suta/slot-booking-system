/**
 * Persistence layer assembly — every adapter the DO's
 * `application/usecases/queue/*` use cases need to run resolved
 * into a single Layer the Dispatcher can pipe through
 * `Effect.provide`.
 *
 * The layer owns the SQL-backed `TicketRepository`, the system
 * `Clock`, the ULID `IdGenerator`, and the Workers `Logger`. The
 * facade (QueueShop) constructs one per dispatch — the use case
 * runtime is single-shot, no caching needed at this volume.
 */
import {
  type Clock,
  type IdGenerator,
  type Logger,
  SystemClockLive,
  type TicketRepository,
  UlidIdGeneratorLive,
} from "@booking/core"
import { Layer } from "effect"
import { WorkersLoggerLive } from "../../adapters/WorkersLoggerLive.js"
import { DurableObjectTicketRepositoryLive } from "./repository.js"

export const persistenceLayer = (
  sql: SqlStorage,
): Layer.Layer<Clock | IdGenerator | TicketRepository | Logger> => {
  const repo = DurableObjectTicketRepositoryLive(sql)
  return Layer.mergeAll(SystemClockLive, UlidIdGeneratorLive, repo, WorkersLoggerLive)
}
