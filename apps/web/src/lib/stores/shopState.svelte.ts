/**
 * Shop-state Svelte 5 reactive store (S17 / ADR-0085).
 *
 * The single source of truth for the live projection feed on the
 * client. `connectQueueFeed` writes every snapshot + applied
 * delta into `shopStateStore.value`; every `.svelte` consumer
 * reads via the same `$state` rune so a route never has to
 * carry its own mirror of the wire payload.
 *
 * The value is the union of the anonymous and staff frame
 * variants the server publishes (per ADR-0083 part 2). The
 * `capability` discriminator on the wire envelope picks which
 * variant the client receives; downstream consumers narrow with
 * the {@link isStaffShopState} guard (which checks the
 * `terminal` field that only the staff variant carries).
 */
import type { ShopState, StaffShopState } from "@booking/core"

export type ShopStateValue = ShopState | StaffShopState

export const isStaffShopState = (v: ShopStateValue): v is StaffShopState => "terminal" in v

/**
 * The reactive container. `value` is `null` until the first WS
 * snapshot arrives so consumers can render a skeleton.
 */
export const shopStateStore = $state<{ value: ShopStateValue | null }>({ value: null })

export const setShopState = (next: ShopStateValue): void => {
  shopStateStore.value = next
}
