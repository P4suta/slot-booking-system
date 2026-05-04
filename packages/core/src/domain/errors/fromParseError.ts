import { ParseResult } from "effect"

/**
 * Render an Effect Schema {@link ParseResult.ParseError} (the value carried by
 * the `Left` of `Schema.decodeUnknownEither`) as a single-line, operator-facing
 * reason string.
 *
 * Used by value-object smart constructors (`parsePhoneLast4`, `parseNameKana`,
 * …) to bridge schema decode failures into our `InvalidXxxError({ reason })`
 * hierarchy. The output is plain text, safe to embed in a log payload
 * (`toLogPayload`) or to return through a JSON error envelope.
 *
 * Implementation:
 *   1. `TreeFormatter.formatErrorSync` produces a multi-line tree where the
 *      first line is the schema banner (`"a string matching the pattern …"`)
 *      and the remaining lines are nested refinement / transformation
 *      failures with tree-drawing prefixes.
 *   2. We return the *deepest* (last) line — the concrete cause — because
 *      the banner just repeats the schema's own identifier and intermediate
 *      frames are mostly boilerplate.
 *   3. The slice after `lastIndexOf("\n")` collapses both single- and
 *      multi-line outputs into one expression: when no newline exists, the
 *      slice begins at index 0 and returns the entire string verbatim.
 */
export const summarizeParse = (error: ParseResult.ParseError): string => {
  const tree = ParseResult.TreeFormatter.formatErrorSync(error)
  return stripTreePrefix(tree.slice(tree.lastIndexOf("\n") + 1))
}

const TREE_PREFIX = /^[\s│├└─]+/

const stripTreePrefix = (line: string): string => line.replace(TREE_PREFIX, "").trim()
