import { RuntimeMode } from "@booking/core"
import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

/**
 * Smoke-level checks that the {@link RuntimeMode} port honours its
 * three properties:
 *
 *   1. `Layer.succeed(RuntimeMode, RuntimeMode.of({ mode }))` lifts
 *      the singleton into the Effect Context.
 *   2. `yield* RuntimeMode` reads the shape synchronously (no Effect
 *      side channel; the field type is a plain record per ADR-0042).
 *   3. The two modes are observationally distinct — providing
 *      `"dev"` vs. `"prod"` selects different downstream Layers via
 *      `Layer.unwrapEffect`, the categorical dispatcher pattern this
 *      port enables.
 */

/**
 * Local probe service to demonstrate the dispatcher; deliberately
 * confined to the test file so its identity does not leak into the
 * application Context graph.
 */
class VerbosityProbe extends Context.Service<VerbosityProbe, { readonly verbose: boolean }>()(
  "test/application/ports/RuntimeMode/VerbosityProbe",
) {}

describe("RuntimeMode", () => {
  it("yields the dev shape under a dev-provided Layer", async () => {
    const program = Effect.gen(function* () {
      const m = yield* RuntimeMode
      return m.mode
    })
    const layer = Layer.succeed(RuntimeMode, RuntimeMode.of({ mode: "dev" }))
    const mode = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(mode).toBe("dev")
  })

  it("yields the prod shape under a prod-provided Layer", async () => {
    const program = Effect.gen(function* () {
      const m = yield* RuntimeMode
      return m.mode
    })
    const layer = Layer.succeed(RuntimeMode, RuntimeMode.of({ mode: "prod" }))
    const mode = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(mode).toBe("prod")
  })

  it("dispatches downstream Layers through Layer.unwrapEffect", async () => {
    // Stand-in for ErrorRedaction / LogSampler — the dispatcher is the
    // categorical bind of `Reader RuntimeMode (Layer ...)` lifted into
    // the Layer space; only the boolean cleavage matters here.
    const dispatched = (mode: "dev" | "prod") =>
      Layer.unwrap(
        Effect.gen(function* () {
          const m = yield* RuntimeMode
          return Layer.succeed(VerbosityProbe, VerbosityProbe.of({ verbose: m.mode === "dev" }))
        }),
      ).pipe(Layer.provide(Layer.succeed(RuntimeMode, RuntimeMode.of({ mode }))))

    const program = Effect.gen(function* () {
      const probe = yield* VerbosityProbe
      return probe.verbose
    })

    const dev = await Effect.runPromise(program.pipe(Effect.provide(dispatched("dev"))))
    const prod = await Effect.runPromise(program.pipe(Effect.provide(dispatched("prod"))))
    expect(dev).toBe(true)
    expect(prod).toBe(false)
  })
})
