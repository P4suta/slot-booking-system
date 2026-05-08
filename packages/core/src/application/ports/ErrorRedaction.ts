import { Context } from "effect"

/**
 * Redacts arbitrary `cause` values (typically `Error` instances or
 * the `_tag`-discriminated TaggedError shape) into a structured
 * record fit for the GraphQL `errors[].extensions` channel.
 *
 * The implementation is selected at the worker boundary based on
 * {@link RuntimeMode}: dev returns a `{ name, message, stack[0..3],
 * originalTag }` preview so the operator can chase the cause without
 * server-side log access; prod returns `{}` (identity-zero) so the
 * client surface stays free of internals — ADR-0017's "cause is
 * `Storage`-only" invariant is preserved at the wire boundary.
 *
 * The contract is intentionally small (one method, one input,
 * Record-shaped output) so the GraphQL adapter can render the result
 * by spreading into `extensions` without further interpretation.
 * ADR-0043 is the formal write-up.
 */
export class ErrorRedaction extends Context.Service<
  ErrorRedaction,
  {
    readonly redact: (cause: unknown) => Record<string, unknown>
  }
>()("@booking/core/ErrorRedaction") {}
