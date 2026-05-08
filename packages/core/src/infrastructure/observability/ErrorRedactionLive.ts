import { Effect, Layer } from "effect"
import { ErrorRedaction } from "../../application/ports/ErrorRedaction.js"
import { RuntimeMode } from "../../application/ports/RuntimeMode.js"

const STACK_FRAME_PREVIEW = 4

/**
 * Walks an `Error.stack` and returns the first {@link STACK_FRAME_PREVIEW}
 * lines joined again. The cap is a defence against accidentally
 * publishing deep async stacks (typically dozens of `~effect/...`
 * frames) onto the wire — operators reading `extensions.cause.stack`
 * want the originating site, not the runtime's machinery.
 */
const previewStack = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  return raw.split("\n").slice(0, STACK_FRAME_PREVIEW).join("\n")
}

/**
 * Dev-side redactor — exposes a `{name, message, stack[0..3],
 * originalTag?}` preview so the operator can chase the cause without
 * server-side log access. Exported standalone so synchronous adapters
 * (HTTP error envelope, OTel exception event) can reuse the canonical
 * definition without spinning up an Effect runtime.
 */
export const devRedactCause = (cause: unknown): Record<string, unknown> => {
  if (cause instanceof Error) {
    const tagged = cause as Error & { readonly _tag?: unknown }
    const stack = previewStack(cause.stack)
    return {
      name: cause.name,
      message: cause.message,
      ...(stack !== undefined ? { stack } : {}),
      ...(typeof tagged._tag === "string" ? { originalTag: tagged._tag } : {}),
    }
  }
  return { value: String(cause) }
}

/**
 * Prod-side redactor — identity-zero (categorical terminal object on
 * the wire surface). ADR-0017's "cause is `Storage`-only" invariant
 * is preserved by construction: nothing leaks past the boundary.
 */
export const prodRedactCause = (_cause: unknown): Record<string, unknown> => ({})

/**
 * Env-indexed adapter selecting {@link devRedactCause} /
 * {@link prodRedactCause} from the resolved {@link RuntimeMode}. The
 * selection is the categorical bind of `Reader RuntimeMode (Layer
 * ErrorRedaction)` lifted through `Layer.unwrap`. ADR-0042 / ADR-0043
 * are the write-ups.
 */
export const ErrorRedactionLive: Layer.Layer<ErrorRedaction, never, RuntimeMode> = Layer.unwrap(
  Effect.gen(function* () {
    const m = yield* RuntimeMode
    return Layer.succeed(
      ErrorRedaction,
      ErrorRedaction.of({ redact: m.mode === "dev" ? devRedactCause : prodRedactCause }),
    )
  }),
)
