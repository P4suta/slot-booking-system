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
import { obsBus } from "../obs/bus.js"

export type ShopStateValue = ShopState | StaffShopState

export const isStaffShopState = (v: ShopStateValue): v is StaffShopState => "terminal" in v

/**
 * The reactive container. `value` is `null` until the first WS
 * snapshot arrives so consumers can render a skeleton.
 */
export const shopStateStore = $state<{ value: ShopStateValue | null }>({ value: null })

/**
 * Build a compact one-line summary of the incoming shop-state for the
 * obs ring. Avoids dumping the whole projection (the wire snapshot is
 * already on the WsFrameIn record) while keeping the diff-friendly
 * triple (capability + waiting count + terminal count for staff).
 *
 * `waitingCount` is a structural member of both `ShopState` and
 * `StaffShopState` (packages/core/src/projection/shopState.ts), so
 * we read it without any cast. `terminal` is only on the staff
 * variant, gated through `isStaffShopState`.
 */
const summariseShopState = (next: ShopStateValue): string => {
  const capability = isStaffShopState(next) ? "staff" : "anonymous"
  const terminalSuffix = isStaffShopState(next) ? ` terminal=${String(next.terminal.length)}` : ""
  return `${capability} waitingCount=${String(next.waitingCount)}${terminalSuffix}`
}

export const setShopState = (next: ShopStateValue): void => {
  shopStateStore.value = next
  obsBus.emit({
    kind: "StoreMutation",
    store: "shopState",
    summary: summariseShopState(next),
    at: Date.now(),
  })
}
