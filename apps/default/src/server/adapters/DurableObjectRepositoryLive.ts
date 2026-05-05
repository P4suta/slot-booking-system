import type { BookingCode, BookingId } from "@booking/core"
import { type Booking, BookingNotFoundError, BookingRepository, BookingSchema } from "@booking/core"
import { Effect, Layer, Schema } from "effect"

/**
 * Cloudflare Durable Object's `state.storage` exposes a transactional
 * key-value store backed (in 2026) by per-object SQLite. We model the
 * read-side projection as two namespaces:
 *
 *   `b:<bookingId>`    → encoded `Booking` (read model)
 *   `c:<bookingCode>`  → `bookingId` (reverse index)
 *
 * Both writes commit inside one `state.storage.transaction(...)` so
 * the reverse index can never observe a half-written booking — the
 * same atomicity guarantee we get from the in-memory `STM` adapter.
 *
 * Encoding goes through `Schema.encodeSync(BookingSchema)`: the wire
 * shape is the schema's `Encoded` projection (ISO-8601 strings for
 * Temporal types, plain JSON for branded primitives) so the storage
 * layout is portable across runtimes — a snapshot exported from the
 * DO can be reloaded by the in-memory layer for tests.
 */
export type DurableStorage = {
  readonly get: <T = unknown>(key: string) => Promise<T | undefined>
  readonly put: <T>(entries: Record<string, T>) => Promise<void>
  readonly delete: (key: string) => Promise<boolean>
  readonly list: <T = unknown>(options?: {
    prefix?: string
    limit?: number
  }) => Promise<Map<string, T>>
  readonly transaction: <A>(fn: (txn: DurableStorage) => Promise<A>) => Promise<A>
}

const bookingKey = (id: BookingId): string => `b:${id}`
const codeKey = (code: BookingCode): string => `c:${code}`

const decodeBooking = Schema.decodeUnknownEither(BookingSchema)
const encodeBooking = Schema.encodeSync(BookingSchema)

/**
 * Load every booking into memory. Used at DO cold start to rebuild
 * any in-process caches (the `BookingCodeIndex` Bloom filter).
 */
export const loadAllBookings = (storage: DurableStorage): Promise<readonly Booking[]> =>
  storage.list<unknown>({ prefix: "b:" }).then((entries) => {
    const out: Booking[] = []
    for (const [, raw] of entries) {
      const decoded = decodeBooking(raw)
      if (decoded._tag === "Right") out.push(decoded.right)
    }
    return out
  })

const decodeOrFail = (raw: unknown): Effect.Effect<Booking, BookingNotFoundError> => {
  const r = decodeBooking(raw)
  if (r._tag === "Right") return Effect.succeed(r.right)
  // The storage row failed to decode — treat as not found rather than
  // surfacing the parse error, since the caller cannot recover from
  // schema drift mid-request. The malformed row will be flagged by
  // the next outbox sync's reconciliation step.
  return Effect.fail(new BookingNotFoundError({}))
}

export const makeDurableObjectRepository = (
  storage: DurableStorage,
): Layer.Layer<BookingRepository> =>
  Layer.succeed(
    BookingRepository,
    BookingRepository.of({
      findById: (id) =>
        Effect.tryPromise({
          try: () => storage.get<unknown>(bookingKey(id)),
          catch: () => new BookingNotFoundError({}),
        }).pipe(
          Effect.flatMap((raw: unknown) =>
            raw === undefined ? Effect.fail(new BookingNotFoundError({})) : decodeOrFail(raw),
          ),
        ),

      findByCode: (code) =>
        Effect.tryPromise({
          try: () => storage.get<BookingId>(codeKey(code)),
          catch: () => new BookingNotFoundError({}),
        }).pipe(
          Effect.flatMap((id: BookingId | undefined) =>
            id === undefined
              ? Effect.fail(new BookingNotFoundError({}))
              : Effect.tryPromise({
                  try: () => storage.get<unknown>(bookingKey(id)),
                  catch: () => new BookingNotFoundError({}),
                }).pipe(
                  Effect.flatMap((raw: unknown) =>
                    raw === undefined
                      ? Effect.fail(new BookingNotFoundError({}))
                      : decodeOrFail(raw),
                  ),
                ),
          ),
        ),

      upsert: (booking) =>
        // Storage failures here are infrastructure-level (disk I/O,
        // quota) — irrecoverable from the use case's perspective. Let
        // them surface as defects via `Effect.promise` so the caller
        // (the DO `runOp`) can convert them to a 500 at the boundary.
        Effect.promise(() =>
          storage.transaction(async (txn) => {
            const encoded = encodeBooking(booking)
            await txn.put({
              [bookingKey(booking.id)]: encoded,
              [codeKey(booking.code)]: booking.id,
            })
          }),
        ),
    }),
  )
