import { reset } from "cloudflare:test"
import * as fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { parseJson, worker } from "../_harness/httpFixture.js"
import { staffHeaders } from "../_harness/jwtFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * Production-path property test (Z2). Drives random valid command
 * sequences through the FULL stack — Hono middleware chain →
 * `app.onError` → QueueShop DurableObject dispatch → SQLite event
 * sourcing → broadcast — and asserts queue-level invariants on the
 * public anonymous projection that the customer landing actually
 * consumes.
 *
 * Coverage that's qualitatively different from the core property
 * tests:
 *
 *   - Real Hono dispatch (`securityHeaders` → `corsAllowlist` →
 *     `envelopeLog` → handler) so a regression in middleware
 *     ordering / response rewrap shows up here, not just in
 *     hand-written smoke tests.
 *   - Real DO ⇄ HTTP marshalling (`stub.dispatch(...)` /
 *     `stub.listTickets()`), so a `structuredClone` boundary issue
 *     surfaces under random pressure rather than a hand-picked
 *     scenario.
 *   - Real D1 storage at the audit + outbox edges.
 *
 * Iteration cost: each command runs an HTTP round-trip (~10-50 ms
 * in Miniflare), so the iteration count is hardcoded at 100 — the
 * shrinker still reliably explores the reachability surface, and a
 * `just fuzz` run completes inside a coffee break.
 */

const SECRET = "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef"
const validHandle = { nameKana: "ヤマダ タロウ", phoneLast4: "1234" }

type Command =
  | { readonly kind: "issue" }
  | { readonly kind: "callNext" }
  | { readonly kind: "markServed" }
  | { readonly kind: "markNoShow" }
  | { readonly kind: "recall" }
  | { readonly kind: "projection" }

const cmdArb: fc.Arbitrary<Command> = fc.oneof(
  fc.constant({ kind: "issue" } as const),
  fc.constant({ kind: "issue" } as const),
  fc.constant({ kind: "issue" } as const),
  fc.constant({ kind: "callNext" } as const),
  fc.constant({ kind: "markServed" } as const),
  fc.constant({ kind: "markNoShow" } as const),
  fc.constant({ kind: "recall" } as const),
  fc.constant({ kind: "projection" } as const),
)

type ProjectionEntry = {
  readonly id: string
  readonly seq: number
  readonly lane: "walkIn" | "priority" | "reservation"
  readonly displaySeq: number
}

type Projection = {
  readonly ok: boolean
  readonly v: 3
  readonly waitingCount: number
  readonly laneCounts: {
    readonly walkIn: number
    readonly priority: number
    readonly reservation: number
  }
  readonly calling: readonly ProjectionEntry[]
  readonly serving: readonly ProjectionEntry[]
  readonly waitingPreview: readonly ProjectionEntry[]
}

// vitest-pool-workers (0.16) doesn't propagate the host's
// `process.env` into the workerd runtime, so the shared `FC_NUM_RUNS`
// override that the core property tests honour is bypassed here.
// Hardcoded 100 — large enough that the shrinker reliably explores
// the reachability surface, small enough to keep `just fuzz` within
// a coffee break (each iteration runs ~5 HTTP commands × ~30 ms
// Miniflare round-trip = ~150 ms / iteration).
const NUM_RUNS = 100

afterEach(async () => {
  await reset()
})

describe("HTTP queue flow (property, integration)", () => {
  it("invariants survive any random HTTP command sequence", async () => {
    const auth = await staffHeaders(SECRET)

    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { minLength: 0, maxLength: 12 }), async (commands) => {
        await reset()
        let issuedCount = 0

        for (const cmd of commands) {
          switch (cmd.kind) {
            case "issue": {
              const r = await worker().fetch(
                req.issueTicket({ handle: validHandle, freeText: null }),
              )
              if (r.status === 201) issuedCount += 1
              break
            }
            case "callNext":
              await worker().fetch(req.callNext(auth.bearerHeaders))
              break
            case "markServed":
            case "markNoShow":
            case "recall": {
              const projRes = await worker().fetch(req.queueProjection())
              const proj = await parseJson<Projection>(projRes)
              const target = proj.calling[0] ?? proj.serving[0]
              if (target === undefined) break
              const id = target.id
              if (cmd.kind === "markServed") {
                await worker().fetch(req.markServed(id, auth.bearerHeaders))
              } else if (cmd.kind === "markNoShow") {
                await worker().fetch(req.markNoShow(id, auth.bearerHeaders))
              } else {
                await worker().fetch(req.recall(id, auth.bearerHeaders))
              }
              break
            }
            case "projection":
              await worker().fetch(req.queueProjection())
              break
          }
        }

        const finalRes = await worker().fetch(req.queueProjection())
        expect(finalRes.status).toBe(200)
        expect(finalRes.headers.get("x-trace-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
        const final = await parseJson<Projection>(finalRes)

        expect(final.ok).toBe(true)
        expect(final.v).toBe(3)
        expect(typeof final.waitingCount).toBe("number")
        expect(final.waitingCount).toBeGreaterThanOrEqual(0)
        // Total tickets in the system can never exceed what was
        // actually issued through the API.
        expect(final.waitingCount).toBeLessThanOrEqual(issuedCount)
        // The waitingPreview is a strict slice of the queue —
        // never longer than the public limit (10) and never
        // longer than the live waitingCount.
        expect(final.waitingPreview.length).toBeLessThanOrEqual(10)
        expect(final.waitingPreview.length).toBeLessThanOrEqual(final.waitingCount)
        // Strictly monotonic per-lane displaySeq across the public
        // preview within each lane (ADR-0065).
        const byLane = new Map<string, ProjectionEntry[]>()
        for (const entry of final.waitingPreview) {
          const list = byLane.get(entry.lane) ?? []
          list.push(entry)
          byLane.set(entry.lane, list)
        }
        for (const list of byLane.values()) {
          for (let i = 1; i < list.length; i += 1) {
            const prev = list[i - 1]
            const curr = list[i]
            if (prev !== undefined && curr !== undefined) {
              expect(curr.displaySeq).toBeGreaterThan(prev.displaySeq)
            }
          }
        }
        // laneCounts agrees with waitingCount across the three lanes.
        const laneTotal =
          final.laneCounts.walkIn + final.laneCounts.priority + final.laneCounts.reservation
        expect(laneTotal).toBe(final.waitingCount)
      }),
      { numRuns: NUM_RUNS, verbose: false },
    )
  } /* per-test wall cap; the integration property is heavy */, 600_000)
})
