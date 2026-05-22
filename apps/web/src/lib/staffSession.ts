/**
 * Staff session state machine.
 *
 * The staff `/staff` route used to mix two pieces of state — the
 * login form's bound input value and the "operator is logged in"
 * flag — into one variable. That coupling let a stray rewrite
 * (`$state(...)` → `$derived(token.length > 0)`) flip the
 * authenticated flag on every keystroke into the password box,
 * bypassing the login submit. The fix, codified here, is to make
 * the session a small tagged union whose transitions are only
 * reachable through the two exported functions below — the page
 * keeps its own separate form-input state and never writes to the
 * session directly.
 *
 * Tests in `apps/web/test/lib/staffSession.test.ts` pin the
 * invariants (empty tokens rejected, persist writes localStorage,
 * clear is idempotent). Any change to the transition surface here
 * must keep those tests green.
 */

export const STAFF_TOKEN_STORAGE_KEY = "queue.staffToken"

/**
 * The session is one of two states. Either the operator has not
 * committed a credential (`anonymous`) or the credential is in
 * localStorage and available to the page (`authenticated`).
 *
 * The credential being in localStorage does NOT, on its own, mean
 * the server accepts it — a stale or rotated secret would still
 * deserialise into `authenticated` and only fail on the next API
 * call. Callers that need a verified credential should probe the
 * staff endpoint before persisting (see `/staff/+page.svelte`'s
 * `onLogin`).
 */
export type StaffSession =
  | { readonly kind: "anonymous" }
  | { readonly kind: "authenticated"; readonly token: string }

const readToken = (): string => {
  if (typeof window === "undefined") return ""
  return window.localStorage.getItem(STAFF_TOKEN_STORAGE_KEY) ?? ""
}

export const readStoredSession = (): StaffSession => {
  const token = readToken()
  return token.length > 0 ? { kind: "authenticated", token } : { kind: "anonymous" }
}

/**
 * Convenience predicate used by customer-facing routes that bounce
 * a logged-in staff session away from the customer surfaces (ADR-0069
 * §Stage 10). Equivalent to `readStoredSession().kind === "authenticated"`
 * but cheaper to call from a hot path.
 */
export const hasStaffSession = (): boolean => readToken().length > 0

/**
 * Commit a credential. Refuses empty / whitespace-only tokens so the
 * caller cannot accidentally persist a "session" that the server
 * would immediately reject as `MissingStaffCapability` on the next
 * call. Returns the resulting `authenticated` session so the caller
 * can assign it without re-deriving.
 */
export const persistStaffSession = (token: string): StaffSession => {
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    throw new Error("staff token must be non-empty")
  }
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STAFF_TOKEN_STORAGE_KEY, trimmed)
  }
  return { kind: "authenticated", token: trimmed }
}

/**
 * Tear down the credential. Idempotent — calling on an already-
 * anonymous state is a no-op. Returns the resulting `anonymous`
 * session for symmetry with `persistStaffSession`.
 */
export const clearStaffSession = (): StaffSession => {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STAFF_TOKEN_STORAGE_KEY)
  }
  return { kind: "anonymous" }
}
