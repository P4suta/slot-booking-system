declare const __brand: unique symbol

/**
 * Phantom-tagged primitive. `Brand<string, "X">` is assignable to `string`
 * but `string` is **not** assignable to `Brand<string, "X">`. Combined
 * with smart constructors that return `Either.Either<Brand<…>, DomainError>`,
 * this enforces parse-don't-validate at compile time.
 */
export type Brand<TBase, TTag extends string> = TBase & {
  readonly [__brand]: TTag
}
