import { devRedactCause, errorToGraphQLExtensions, prodRedactCause } from "@booking/core"
import { describe, expect, it } from "vitest"

/**
 * Pin the wire contract for the dev/prod cleavage of
 * `errorToGraphQLExtensions` so future contributors cannot widen the
 * prod redactor (ADR-0017 invariant) or narrow the dev redactor
 * (operator-triage utility).
 *
 * The plugin in `yoga.ts` exercises the same derivation against
 * synthetic GraphQLError instances — the test here pins the pure
 * function so the plugin's behaviour is determined by the env switch
 * alone.
 */

describe("errorToGraphQLExtensions", () => {
  it("dev redactor exposes name/message/stack/originalTag", () => {
    const cause = new TypeError('Could not serialize object of type "Object"')
    cause.name = "DataCloneError"
    cause.stack =
      'DataCloneError: Could not serialize object of type "Object"\n    at frame1\n    at frame2\n    at frame3\n    at frame4\n    at frame5'
    const extras = errorToGraphQLExtensions(cause, devRedactCause)
    expect(extras).toMatchObject({
      cause: {
        name: "DataCloneError",
        message: 'Could not serialize object of type "Object"',
      },
    })
    const causeField = (extras as { cause: { stack: string } }).cause
    // Stack is capped to four frames — anything beyond is dropped.
    expect(causeField.stack.split("\n")).toHaveLength(4)
  })

  it("dev redactor surfaces _tag as originalTag", () => {
    const cause = new Error("denied")
    ;(cause as Error & { _tag: string })._tag = "InsufficientCapability"
    const extras = errorToGraphQLExtensions(cause, devRedactCause)
    expect(extras).toMatchObject({
      cause: { originalTag: "InsufficientCapability" },
      originalTag: "InsufficientCapability",
    })
  })

  it("prod redactor returns identity-zero — no internal leak", () => {
    const cause = new Error("anything")
    const extras = errorToGraphQLExtensions(cause, prodRedactCause)
    // No `cause` key (redact returned `{}`); `originalTag` only appears
    // when the cause carries a `_tag` discriminator, which a plain Error
    // does not.
    expect(extras).toEqual({})
  })

  it("prod redactor still drops _tag info from the wire payload", () => {
    const cause = new Error("denied")
    ;(cause as Error & { _tag: string })._tag = "InsufficientCapability"
    const extras = errorToGraphQLExtensions(cause, prodRedactCause)
    // The redactor's output is empty so `cause` is omitted, but the
    // top-level `originalTag` is still derived from the cause's `_tag`
    // field — this is the documented categorical split: prod keeps the
    // discriminator (which the i18n key already carries via
    // `errorToGraphQLPayload`) and drops the message preview.
    expect(extras).toEqual({ originalTag: "InsufficientCapability" })
  })

  it("returns empty when cause is null/undefined", () => {
    expect(errorToGraphQLExtensions(null, devRedactCause)).toEqual({})
    expect(errorToGraphQLExtensions(undefined, devRedactCause)).toEqual({})
  })
})
