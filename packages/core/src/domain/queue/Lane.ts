import { Schema } from "effect"

/**
 * Lane partitions the queue by operator-grade ordering policy
 * (ADR-0062). Sequence monotonicity (`seq`) remains globally
 * monotone (ADR-0051); FIFO within a lane is governed by
 * `displaySeq` (ADR-0065).
 *
 *   - `walkIn` — the default lane; new tickets land here unless
 *     the operator routes them elsewhere.
 *   - `priority` — VIP / named-complaint customers; the
 *     preferred-lane chain consumes this lane ahead of `walkIn`.
 *   - `reservation` — booked customers waiting for their slot;
 *     consumed last by default but selectable explicitly.
 */
export const LaneSchema = Schema.Literals(["walkIn", "priority", "reservation"])
export type Lane = Schema.Schema.Type<typeof LaneSchema>

export const ALL_LANES: readonly Lane[] = ["walkIn", "priority", "reservation"] as const

/**
 * The order `CallNext` consumes lanes when no `lane` argument is
 * supplied (ADR-0062). The first lane in this list with a Waiting
 * ticket wins.
 */
export const PREFERRED_LANE_CHAIN: readonly Lane[] = ["priority", "walkIn", "reservation"] as const
