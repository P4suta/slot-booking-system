import { Schema } from "effect"

/**
 * Lane partitions the queue by intake source (ADR-0062, narrowed by
 * ADR-0078). Sequence monotonicity (`seq`) is globally monotone
 * (ADR-0051); `displaySeq` is globally monotone too (ADR-0078) so
 * customer-facing 整理券番号 never duplicate.
 *
 *   - `walkIn` — the default lane; new tickets land here unless the
 *     customer pinned an appointment time.
 *   - `reservation` — booked customers waiting for their slot;
 *     consumed last by default but selectable explicitly (or
 *     promoted ahead via the EDF grace window, ADR-0067).
 *
 * The historic `priority` lane was removed in ADR-0078: customers
 * cannot legitimately self-mark as priority, and there was no
 * operator surface to promote/demote, so the lane only existed as a
 * footgun (any client could self-issue with `lane: "priority"`).
 */
export const LaneSchema = Schema.Literals(["walkIn", "reservation"])
export type Lane = Schema.Schema.Type<typeof LaneSchema>

export const ALL_LANES: readonly Lane[] = ["walkIn", "reservation"] as const

/**
 * The order `CallNext` consumes lanes when no `lane` argument is
 * supplied (ADR-0062, ADR-0067). The first lane in this list with a
 * Waiting ticket wins; the EDF grace window (ADR-0067) pre-empts
 * with a due reservation regardless of chain order.
 */
export const PREFERRED_LANE_CHAIN: readonly Lane[] = ["walkIn", "reservation"] as const
