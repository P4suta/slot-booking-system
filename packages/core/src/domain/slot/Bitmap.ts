import { dual } from "effect/Function"

/**
 * Fixed-length boolean array, backed by an arbitrary-precision `bigint`.
 * Used as the primitive for per-day Provider / Resource availability so
 * slot computation reduces to bitwise AND / OR / NOT / shift over a
 * single value (ADR-0012).
 *
 * Bit indexing: bit `b` is `(value >> BigInt(b)) & 1n`.
 *
 * Bitmap is **immutable**. Every operation returns a new Bitmap; the
 * underlying `bigint` is a primitive, so external mutation is
 * impossible by construction. No array indexing is required, which
 * eliminates the `noUncheckedIndexedAccess` friction and lets every
 * function be a total expression with no defensive branches.
 *
 * **Calling style** — combinators that take a Bitmap as their first
 * non-trivial argument are dual: they accept either `op(bm, …)` (data-
 * first) or `pipe(bm, op(…))` (data-last). Unary operations stay
 * data-first only.
 */
export type Bitmap = {
  readonly value: bigint
  readonly length: number
}

const ZERO = 0n
const ONE = 1n

const safeLen = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

const lenMask = (length: number): bigint => (ONE << BigInt(length)) - ONE

const make = (length: number, value: bigint): Bitmap => {
  const len = safeLen(length)
  return { value: value & lenMask(len), length: len }
}

/** All-zeros bitmap of `length` bits. Negative or non-integer inputs clamp to 0. */
export const empty = (length: number): Bitmap => make(length, ZERO)

/** All-ones bitmap of `length` bits. */
export const full = (length: number): Bitmap => make(length, lenMask(safeLen(length)))

/** True iff bit `idx` is set. Out-of-range queries return `false`. */
export const isSet = (bm: Bitmap, idx: number): boolean => {
  if (idx < 0 || idx >= bm.length) return false
  return ((bm.value >> BigInt(idx)) & ONE) === ONE
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n)

const rangeMask = (start: number, end: number, length: number): bigint => {
  const lo = clamp(Math.floor(start), 0, length)
  const hi = clamp(Math.floor(end), 0, length)
  if (hi <= lo) return ZERO
  return ((ONE << BigInt(hi - lo)) - ONE) << BigInt(lo)
}

/** Returns a new bitmap with bits in `[start, end)` set to 1, clamped to the bitmap. */
export const setRange: {
  (start: number, end: number): (bm: Bitmap) => Bitmap
  (bm: Bitmap, start: number, end: number): Bitmap
} = dual(
  3,
  (bm: Bitmap, start: number, end: number): Bitmap => ({
    value: (bm.value | rangeMask(start, end, bm.length)) & lenMask(bm.length),
    length: bm.length,
  }),
)

/** Returns a new bitmap with bits in `[start, end)` cleared to 0. */
export const clearRange: {
  (start: number, end: number): (bm: Bitmap) => Bitmap
  (bm: Bitmap, start: number, end: number): Bitmap
} = dual(
  3,
  (bm: Bitmap, start: number, end: number): Bitmap => ({
    value: bm.value & ~rangeMask(start, end, bm.length) & lenMask(bm.length),
    length: bm.length,
  }),
)

/**
 * Bitwise AND. The shorter length wins; the result is the union over
 * the common prefix (bits above the shorter length are dropped).
 */
export const and: {
  (b: Bitmap): (a: Bitmap) => Bitmap
  (a: Bitmap, b: Bitmap): Bitmap
} = dual(2, (a: Bitmap, b: Bitmap): Bitmap => {
  const len = Math.min(a.length, b.length)
  return { value: a.value & b.value & lenMask(len), length: len }
})

/**
 * Bitwise OR. The shorter length wins; bits above the shorter length
 * are masked off so the result is a well-formed bitmap.
 */
export const or: {
  (b: Bitmap): (a: Bitmap) => Bitmap
  (a: Bitmap, b: Bitmap): Bitmap
} = dual(2, (a: Bitmap, b: Bitmap): Bitmap => {
  const len = Math.min(a.length, b.length)
  return { value: (a.value | b.value) & lenMask(len), length: len }
})

/** Bitwise NOT, masked to the bitmap length. */
export const not = (bm: Bitmap): Bitmap => ({
  value: ~bm.value & lenMask(bm.length),
  length: bm.length,
})

/**
 * Shift bits toward index 0 by `n` positions. Bit `b` of the result is
 * bit `b + n` of the input; bits beyond the original length become 0.
 *
 * `n <= 0` is the identity; `n >= bm.length` is the all-zeros bitmap.
 */
export const shiftDown: {
  (n: number): (bm: Bitmap) => Bitmap
  (bm: Bitmap, n: number): Bitmap
} = dual(2, (bm: Bitmap, n: number): Bitmap => {
  if (n <= 0) return bm
  if (n >= bm.length) return empty(bm.length)
  return {
    value: (bm.value >> BigInt(n)) & lenMask(bm.length),
    length: bm.length,
  }
})

/**
 * Population count via Brian Kernighan's bit-twiddling: each iteration
 * `v &= v - 1n` clears the lowest set bit, so the loop runs once per
 * set bit instead of once per bit position. O(popcount) rather than
 * O(length).
 */
export const popcount = (bm: Bitmap): number => {
  let v = bm.value
  let total = 0
  while (v > ZERO) {
    v &= v - ONE
    total++
  }
  return total
}

/**
 * Find every starting offset `b` such that bits `[b, b + runLength)` of
 * `bm` are all 1. Returns ascending offsets.
 *
 * Algorithm: AND `bm` with `bm` shifted down by 1, 2, …, runLength-1.
 * Each AND adds one constraint. After `runLength - 1` ANDs, bit `b`
 * is set iff the original `runLength` consecutive bits were all 1.
 *
 * `runLength <= 0` returns every valid offset; `runLength > bm.length`
 * returns the empty array.
 */
export const findRunsOfLength: {
  (runLength: number): (bm: Bitmap) => readonly number[]
  (bm: Bitmap, runLength: number): readonly number[]
} = dual(2, (bm: Bitmap, runLength: number): readonly number[] => {
  if (runLength <= 0) {
    return Array.from({ length: bm.length }, (_, i) => i)
  }
  if (runLength > bm.length) return []
  let acc = bm.value
  for (let i = 1; i < runLength; i++) {
    acc &= bm.value >> BigInt(i)
  }
  const out: number[] = []
  const limit = bm.length - runLength + 1
  for (let i = 0; i < limit; i++) {
    if (((acc >> BigInt(i)) & ONE) === ONE) out.push(i)
  }
  return out
})

/** Equality (same length, same value). */
export const equals: {
  (b: Bitmap): (a: Bitmap) => boolean
  (a: Bitmap, b: Bitmap): boolean
} = dual(2, (a: Bitmap, b: Bitmap): boolean => a.length === b.length && a.value === b.value)

/** Diagnostic: render as a `0`/`1` string of `bm.length` chars, bit 0 first. */
export const toBinaryString = (bm: Bitmap): string => {
  if (bm.length === 0) return ""
  const out: string[] = []
  for (let i = 0; i < bm.length; i++) out.push(((bm.value >> BigInt(i)) & ONE) === ONE ? "1" : "0")
  return out.join("")
}

/** Build a bitmap from a `0`/`1` string. Inverse of `toBinaryString`. */
export const fromBinaryString = (s: string): Bitmap => {
  let value = ZERO
  for (let i = 0; i < s.length; i++) {
    if (s.charAt(i) === "1") value |= ONE << BigInt(i)
  }
  return { value, length: s.length }
}
