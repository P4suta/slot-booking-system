import type { SchemaIssue } from "effect"
import { SchemaIssue as Issue } from "effect"

const formatter = Issue.makeFormatterDefault()

/**
 * Render an Effect Schema {@link SchemaIssue.Issue} (the error carried by
 * the `Failure` of `Schema.decodeUnknownResult`) as a single-line,
 * operator-facing reason string.
 *
 * Used by value-object smart constructors (`parsePhoneLast4`, `parseNameKana`,
 * …) to bridge schema decode failures into our `InvalidXxxError({ reason })`
 * hierarchy. The output is plain text, safe to embed in a log payload
 * (`toLogPayload`) or to return through a JSON error envelope.
 *
 * Implementation: Effect 4 ships a default `Formatter<string>` from
 * `SchemaIssue.makeFormatterDefault()` that walks the issue tree and
 * renders one line per leaf. We pick the deepest (last) line — the
 * concrete cause — because the banner just repeats the schema's
 * identifier and intermediate frames are mostly boilerplate. The
 * tree-prefix strip collapses both single- and multi-line outputs
 * into one expression.
 */
export const summarizeParse = (issue: SchemaIssue.Issue): string => {
  const tree = formatter(issue)
  const firstNewline = tree.indexOf("\n")
  const head = firstNewline === -1 ? tree : tree.slice(0, firstNewline)
  return stripTreePrefix(head)
}

/**
 * Walk a {@link SchemaIssue.Issue} tree and return the first
 * top-level property key whose decode failed, or `undefined` for a
 * root-level failure (e.g. wrong type for the entire body).
 *
 * The HTTP boundary uses this to dispatch a `Schema.Struct` decode
 * failure to a field-specific tag (`InvalidPhoneLast4`,
 * `InvalidNameKana`, …). The lookup is path[0]: nested failures
 * (e.g. inside a record field) carry the *struct* key, which is
 * the granularity the response envelope cares about.
 *
 * `Pointer` carries the property path explicitly. `Composite` /
 * `AnyOf` aggregate sibling failures — we recurse into each child
 * and stop at the first hit. `Filter` / `Encoding` wrap a single
 * inner issue (refinement / transformation failure); we descend
 * into `.issue`. Leaf variants (`InvalidType`, `InvalidValue`,
 * `MissingKey`, `UnexpectedKey`, `Forbidden`, `OneOf`) carry no
 * sub-path and yield `undefined`.
 */
export const firstFailedFieldKey = (issue: SchemaIssue.Issue): string | undefined => {
  switch (issue._tag) {
    case "Pointer": {
      const head = issue.path[0]
      if (typeof head === "string") return head
      return firstFailedFieldKey(issue.issue)
    }
    case "Composite":
    case "AnyOf":
      for (const child of issue.issues) {
        const found = firstFailedFieldKey(child)
        if (found !== undefined) return found
      }
      return undefined
    case "Filter":
    case "Encoding":
      return firstFailedFieldKey(issue.issue)
    default:
      return undefined
  }
}

const TREE_PREFIX = /^[\s│├└─]+/

const stripTreePrefix = (line: string): string => line.replace(TREE_PREFIX, "").trim()
