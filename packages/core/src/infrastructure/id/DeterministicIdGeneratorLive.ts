import { Effect, Layer, Ref } from "effect"
import { IdGenerator } from "../../application/ports/IdGenerator.js"
import type {
  AuditLogId,
  IdempotencyKeyId,
  StaffId,
  TicketEventId,
  TicketId,
} from "../../domain/types/EntityId.js"

const SUFFIX_LEN = 26
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

const encodeCounter = (n: number): string => {
  let acc = ""
  let x = n
  for (let i = 0; i < SUFFIX_LEN; i++) {
    const idx = x % ALPHABET.length
    acc = ALPHABET[idx] + acc
    x = Math.floor(x / ALPHABET.length)
  }
  return acc
}

/**
 * Test adapter for `IdGenerator`. Each kind has its own counter so
 * fixtures can assert "the third ticket id is `tkt_…01v`" without
 * relying on cross-kind ordering. Reproducible under property tests.
 */
export const DeterministicIdGeneratorLive = Layer.effect(
  IdGenerator,
  Effect.gen(function* () {
    const tkt = yield* Ref.make(0)
    const tev = yield* Ref.make(0)
    const staf = yield* Ref.make(0)
    const audt = yield* Ref.make(0)
    const idem = yield* Ref.make(0)
    const mint = <T extends string>(prefix: string, ref: Ref.Ref<number>): Effect.Effect<T> =>
      Ref.modify(ref, (n) => {
        const next = n + 1
        return [`${prefix}_${encodeCounter(next)}` as T, next] as const
      })
    return {
      newTicketId: mint<TicketId>("tkt", tkt),
      newTicketEventId: mint<TicketEventId>("tev", tev),
      newStaffId: mint<StaffId>("staf", staf),
      newAuditLogId: mint<AuditLogId>("audt", audt),
      newIdempotencyKeyId: mint<IdempotencyKeyId>("idem", idem),
    }
  }),
)
