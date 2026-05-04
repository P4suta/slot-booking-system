/**
 * Fixed-length boolean array, packed into 32-bit words. Used as the
 * primitive for per-day Provider / Resource availability so that slot
 * computation reduces to bitwise AND/OR over `Math.ceil(length / 32)`
 * words (ADR-0012).
 *
 * Bit indexing: bit `b` lives in `words[b >>> 5]` at offset `b & 31`.
 *
 * Bitmap is **immutable from the outside**. Every operation returns a
 * new bitmap; the underlying `Uint32Array` of an existing bitmap is
 * never mutated by callers.
 */
export type Bitmap = {
  readonly words: Uint32Array
  readonly length: number
}

const WORD_BITS = 32

const wordsFor = (length: number): number =>
  length <= 0 ? 0 : ((length + WORD_BITS - 1) / WORD_BITS) | 0

const maskTail = (words: Uint32Array, length: number): Uint32Array => {
  const last = words.length - 1
  if (last < 0) return words
  const trailing = length - last * WORD_BITS
  if (trailing >= WORD_BITS) return words
  if (trailing <= 0) {
    words[last] = 0
  } else {
    const keep = (1 << trailing) - 1
    // biome-ignore lint/style/noNonNullAssertion: index is in bounds by construction
    words[last] = (words[last]! & keep) >>> 0
  }
  return words
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n)

const make = (length: number, init: 0 | 1): Bitmap => {
  const safeLength = Math.max(0, length | 0)
  const words = new Uint32Array(wordsFor(safeLength))
  if (init === 1) {
    words.fill(0xff_ff_ff_ff)
    maskTail(words, safeLength)
  }
  return { words, length: safeLength }
}

/** All-zeros bitmap of `length` bits. Negative or non-integer inputs are clamped. */
export const empty = (length: number): Bitmap => make(length, 0)

/** All-ones bitmap of `length` bits. */
export const full = (length: number): Bitmap => make(length, 1)

/** True iff bit `idx` is set. Out-of-range indices return `false`. */
export const isSet = (bm: Bitmap, idx: number): boolean => {
  if (idx < 0 || idx >= bm.length) return false
  // biome-ignore lint/style/noNonNullAssertion: word index is in bounds
  return ((bm.words[idx >>> 5]! >>> (idx & 31)) & 1) === 1
}

/** Returns a new bitmap with bits in `[start, end)` set to 1, clamped to `[0, bm.length)`. */
export const setRange = (bm: Bitmap, start: number, end: number): Bitmap => {
  const lo = clamp(start | 0, 0, bm.length)
  const hi = clamp(end | 0, 0, bm.length)
  if (hi <= lo) return bm
  const words = new Uint32Array(bm.words)
  const startWord = lo >>> 5
  const endWord = (hi - 1) >>> 5
  const startBit = lo & 31
  const endBit = (hi - 1) & 31
  if (startWord === endWord) {
    const lowMask = startBit === 0 ? 0xff_ff_ff_ff : ~((1 << startBit) - 1) >>> 0
    const highMask = endBit === 31 ? 0xff_ff_ff_ff : ((1 << (endBit + 1)) - 1) >>> 0
    // biome-ignore lint/style/noNonNullAssertion: in bounds
    words[startWord] = (words[startWord]! | (lowMask & highMask)) >>> 0
  } else {
    const firstMask = startBit === 0 ? 0xff_ff_ff_ff : ~((1 << startBit) - 1) >>> 0
    // biome-ignore lint/style/noNonNullAssertion: in bounds
    words[startWord] = (words[startWord]! | firstMask) >>> 0
    for (let i = startWord + 1; i < endWord; i++) {
      words[i] = 0xff_ff_ff_ff
    }
    const lastMask = endBit === 31 ? 0xff_ff_ff_ff : ((1 << (endBit + 1)) - 1) >>> 0
    // biome-ignore lint/style/noNonNullAssertion: in bounds
    words[endWord] = (words[endWord]! | lastMask) >>> 0
  }
  maskTail(words, bm.length)
  return { words, length: bm.length }
}

/** Returns a new bitmap with bits in `[start, end)` cleared to 0. */
export const clearRange = (bm: Bitmap, start: number, end: number): Bitmap => {
  const lo = clamp(start | 0, 0, bm.length)
  const hi = clamp(end | 0, 0, bm.length)
  if (hi <= lo) return bm
  const words = new Uint32Array(bm.words)
  const startWord = lo >>> 5
  const endWord = (hi - 1) >>> 5
  const startBit = lo & 31
  const endBit = (hi - 1) & 31
  if (startWord === endWord) {
    const lowMask = startBit === 0 ? 0xff_ff_ff_ff : ~((1 << startBit) - 1) >>> 0
    const highMask = endBit === 31 ? 0xff_ff_ff_ff : ((1 << (endBit + 1)) - 1) >>> 0
    const range = (lowMask & highMask) >>> 0
    // biome-ignore lint/style/noNonNullAssertion: in bounds
    words[startWord] = (words[startWord]! & ~range) >>> 0
  } else {
    const firstMask = startBit === 0 ? 0xff_ff_ff_ff : ~((1 << startBit) - 1) >>> 0
    // biome-ignore lint/style/noNonNullAssertion: in bounds
    words[startWord] = (words[startWord]! & ~firstMask) >>> 0
    for (let i = startWord + 1; i < endWord; i++) {
      words[i] = 0
    }
    const lastMask = endBit === 31 ? 0xff_ff_ff_ff : ((1 << (endBit + 1)) - 1) >>> 0
    // biome-ignore lint/style/noNonNullAssertion: in bounds
    words[endWord] = (words[endWord]! & ~lastMask) >>> 0
  }
  return { words, length: bm.length }
}

const sameLength = (a: Bitmap, b: Bitmap): boolean => a.length === b.length

/** Bitwise AND. If lengths differ, the shorter length wins (excess bits in the longer side are dropped). */
export const and = (a: Bitmap, b: Bitmap): Bitmap => {
  const length = Math.min(a.length, b.length)
  const words = new Uint32Array(wordsFor(length))
  for (let i = 0; i < words.length; i++) {
    words[i] = ((a.words[i] ?? 0) & (b.words[i] ?? 0)) >>> 0
  }
  maskTail(words, length)
  return { words, length }
}

/** Bitwise OR. Lengths must match; if not, the longer length wins. */
export const or = (a: Bitmap, b: Bitmap): Bitmap => {
  const length = Math.max(a.length, b.length)
  const words = new Uint32Array(wordsFor(length))
  for (let i = 0; i < words.length; i++) {
    words[i] = ((a.words[i] ?? 0) | (b.words[i] ?? 0)) >>> 0
  }
  maskTail(words, length)
  return { words, length }
}

/** Bitwise NOT, masked to the bitmap length. */
export const not = (bm: Bitmap): Bitmap => {
  const words = new Uint32Array(bm.words.length)
  for (let i = 0; i < words.length; i++) {
    words[i] = ~(bm.words[i] ?? 0) >>> 0
  }
  maskTail(words, bm.length)
  return { words, length: bm.length }
}

/**
 * Shift bits toward index 0 by `n` positions. Bit `b` of the result is
 * bit `b + n` of the input; bits beyond the original length become 0.
 *
 * Negative or zero `n` returns the bitmap unchanged.
 */
export const shiftDown = (bm: Bitmap, n: number): Bitmap => {
  if (n <= 0 || bm.length === 0) return bm
  if (n >= bm.length) return empty(bm.length)
  const wordShift = (n / WORD_BITS) | 0
  const bitShift = n % WORD_BITS
  const wc = bm.words.length
  const words = new Uint32Array(wc)
  for (let i = 0; i < wc; i++) {
    const srcLo = i + wordShift
    const srcHi = srcLo + 1
    const lo = (srcLo < wc ? bm.words[srcLo] : 0) ?? 0
    const hi = (srcHi < wc ? bm.words[srcHi] : 0) ?? 0
    words[i] = bitShift === 0 ? lo : ((lo >>> bitShift) | (hi << (WORD_BITS - bitShift))) >>> 0
  }
  maskTail(words, bm.length)
  return { words, length: bm.length }
}

/** Population count (number of set bits). Hamming-weight per word. */
export const popcount = (bm: Bitmap): number => {
  let total = 0
  for (let i = 0; i < bm.words.length; i++) {
    let v = bm.words[i] ?? 0
    v = v - ((v >>> 1) & 0x55_55_55_55)
    v = (v & 0x33_33_33_33) + ((v >>> 2) & 0x33_33_33_33)
    v = (v + (v >>> 4)) & 0x0f_0f_0f_0f
    total += (Math.imul(v, 0x01_01_01_01) >>> 24) & 0xff
  }
  return total
}

/**
 * Find every starting offset `b` such that bits `[b, b + runLength)` of
 * `bm` are all 1. Returns ascending offsets.
 *
 * Implementation: AND `bm` with `bm` shifted down by 1, 2, …, runLength-1.
 * Each AND adds one constraint. After `runLength - 1` ANDs, bit `b` is
 * set iff the original `runLength` consecutive bits were all 1.
 *
 * `runLength <= 0` returns every valid offset; `runLength > bm.length`
 * returns the empty array.
 */
export const findRunsOfLength = (bm: Bitmap, runLength: number): number[] => {
  if (runLength <= 0) {
    return Array.from({ length: bm.length }, (_, i) => i)
  }
  if (runLength > bm.length) return []
  let acc = bm
  for (let i = 1; i < runLength; i++) {
    acc = and(acc, shiftDown(bm, i))
  }
  const out: number[] = []
  const limit = bm.length - runLength + 1
  for (let i = 0; i < limit; i++) {
    if (isSet(acc, i)) out.push(i)
  }
  return out
}

/** Equality (same length, same word contents). */
export const equals = (a: Bitmap, b: Bitmap): boolean => {
  if (!sameLength(a, b)) return false
  if (a.words.length !== b.words.length) return false
  for (let i = 0; i < a.words.length; i++) {
    if (a.words[i] !== b.words[i]) return false
  }
  return true
}

/** Diagnostic: render as a `0`/`1` string of `bm.length` chars. */
export const toBinaryString = (bm: Bitmap): string => {
  const out: string[] = []
  for (let i = 0; i < bm.length; i++) out.push(isSet(bm, i) ? "1" : "0")
  return out.join("")
}

/** Build a bitmap from a `0`/`1` string. Inverse of `toBinaryString`. */
export const fromBinaryString = (s: string): Bitmap => {
  const bm = empty(s.length)
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "1") {
      const w = i >>> 5
      const b = i & 31
      bm.words[w] = ((bm.words[w] ?? 0) | (1 << b)) >>> 0
    }
  }
  return bm
}
