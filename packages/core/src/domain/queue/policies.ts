/**
 * Queue domain policies — magnitudes and predicates that arbitrate the
 * lifecycle of a single ticket (ADR-0078).
 *
 * This module is the single source of truth for:
 *
 *   - `isCallableNow` — the EDF (Earliest-Deadline-First) lateness lens
 *     that decides whether a `Waiting` ticket has reached the window in
 *     which staff are allowed to ring it.
 *   - `Policies` — `Duration<K>` constants used across server, web, and
 *     core (`RESERVATION_GRACE`, `SERVING_THRESHOLD`, `PENDING_NOSHOW_TTL`,
 *     `BROADCAST_COALESCE`, `WS_KEEPALIVE`, `CHECK_IN_WINDOW`).
 *
 * Stage 1 wires the file but defers the predicate / constants to
 * Stage 2 (ADR-0078). Importing this file at S1 yields nothing — the
 * symbol surface lands in the same module across the next commit.
 */
export {}
