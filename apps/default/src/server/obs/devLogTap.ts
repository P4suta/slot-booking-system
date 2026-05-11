/**
 * Dev log tap — module-level seam between the worker's
 * structured-log emit sites and the `DevLogStream` DO.
 *
 * Stage 22b cont. / ADR-0091.
 *
 * The pattern mirrors `__setRequestLogTap` (`requestLog.ts`)
 * and `__setEnvelopeLogTap` (`errorEnvelope.ts`): a free
 * function the emit site calls unconditionally, plus a setter
 * the worker root flips on once per request when `IS_DEV=1`.
 * Production never sets the publisher, so `publishDevLog` is
 * a one-null-check no-op in the hot path.
 *
 * The `emit` helper centralises the `console.{info,warn,error}`
 * dispatch + the tap call, so the four upstream emit sites
 * (`WorkersLoggerLive` / `requestLog` / `errorEnvelope` /
 * `clientReport`) all share the same one-line invocation. The
 * `biome-ignore` for `noConsole` lives here once instead of
 * being repeated per site.
 */
import type { DevLogEntry } from "../durableObjects/DevLogStream.js"

export type { DevLogEntry }

let publisher: ((entry: DevLogEntry) => void) | null = null

/**
 * Register or clear the dev-log publisher. Called from the
 * worker root on every `fetch` when `IS_DEV=1` (registers the
 * DO stub's `publishLog`) and from tests (registers a tap
 * capture / clears between cases).
 */
export const __setDevLogPublisher = (next: ((entry: DevLogEntry) => void) | null): void => {
  publisher = next
}

/**
 * Relay one entry through the registered publisher. No-op when
 * unset (prod path, or pre-instrumentation tests). Internal to
 * this module — call sites use {@link emitStructuredLog} which
 * pairs `console.{x}` emission with the relay.
 */
const publishDevLog = (entry: DevLogEntry): void => {
  if (publisher !== null) publisher(entry)
}

/**
 * Structured-log emit helper. Writes the already-serialised
 * JSON `line` to the matching `console.{level}` sink and
 * forwards a `DevLogEntry` to the dev relay (if registered).
 *
 * All four emit sites in the worker (`WorkersLoggerLive`,
 * `requestLog`, `errorEnvelope`, `clientReport`) call through
 * here so the dev relay sees the exact byte sequence the
 * operator dashboard ingests.
 */
export const emitStructuredLog = (level: "info" | "warn" | "error", line: string): void => {
  // biome-ignore lint/suspicious/noConsole: structured worker log sink (chain covered by single suppression)
  if (level === "info") console.info(line)
  else if (level === "warn") console.warn(line)
  else console.error(line)
  publishDevLog({ level, emittedAt: Date.now(), line })
}
