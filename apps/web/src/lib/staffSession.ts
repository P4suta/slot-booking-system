import { writable } from "svelte/store"

/**
 * Whether a staff token is present in localStorage. The store is
 * the canonical signal — `+layout.svelte` reads it to decide
 * whether to render the ログアウト button next to the brand link,
 * and `/staff/+page.svelte` writes it on login / logout.
 *
 * Initialised lazily on the client (SSR has no localStorage).
 */
export const staffSessionActive = writable<boolean>(false)

const STAFF_TOKEN_KEY = "queue.staffToken"

export const initStaffSession = (): void => {
  if (typeof window === "undefined") return
  staffSessionActive.set(window.localStorage.getItem(STAFF_TOKEN_KEY) !== null)
}

export const markStaffLoggedIn = (): void => {
  staffSessionActive.set(true)
}

/**
 * Wipe the token, flip the store, and stop pretending we have a
 * staff session. Used both by `/staff`'s in-page button and by
 * the layout-level logout chip.
 */
export const clearStaffSession = (): void => {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STAFF_TOKEN_KEY)
  }
  staffSessionActive.set(false)
}
