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

const TREE_PREFIX = /^[\s│├└─]+/

const stripTreePrefix = (line: string): string => line.replace(TREE_PREFIX, "").trim()
