/**
 * Immutable BigInt-backed Bloom filter for the BookingCode index.
 *
 * Used as a pre-database filter (`mayContain`) so most cancel /
 * reschedule lookups for a typo'd code terminate before we hit D1.
 * False positives are tolerated (we fall through to a real lookup);
 * false negatives are forbidden (a real entry must always be reported
 * as possibly present).
 *
 * Hashing uses the **Kirsch–Mitzenmacher** double-hash construction:
 * `h_i(x) = (FNV1a(x) + i × xxh32(x)) mod m`. Two cheap 32-bit hashes
 * yield `k` independent positions with no measurable bias for the
 * `m`/`k` ranges we expect (m ~ 16 KB, k ≤ 8).
 *
 * The bit array lives in a `bigint` (no `Uint8Array` allocation per
 * mutation), matching the immutable style used by `slot/Bitmap.ts`
 * (ADR-0012).
 */

export type BloomFilter = {
  /** Total number of bits. */
  readonly size: number
  /** Number of hash functions per insertion. */
  readonly hashCount: number
  /** Bit array, packed least-significant bit first. */
  readonly bits: bigint
}

const ZERO = 0n
const ONE = 1n

const MAX_HASH_COUNT = 32

const isFiniteInt = (n: number): boolean => Number.isInteger(n) && Number.isFinite(n)

const validate = (size: number, hashCount: number): void => {
  if (!isFiniteInt(size) || size <= 0) {
    throw new RangeError("BloomFilter: size must be a positive integer")
  }
  if (!isFiniteInt(hashCount) || hashCount <= 0 || hashCount > MAX_HASH_COUNT) {
    throw new RangeError(`BloomFilter: hashCount must be in [1, ${MAX_HASH_COUNT}]`)
  }
}

/**
 * 32-bit FNV-1a. Total over `string`. Returns an unsigned int via
 * `>>> 0`.
 */
const fnv1a = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 32-bit MurmurHash3 (x86 variant). Cheap, well-distributed second hash
 * for the Kirsch–Mitzenmacher construction.
 */
const murmur3 = (s: string, seed = 0): number => {
  let h1 = seed >>> 0
  const c1 = 0xcc9e2d51
  const c2 = 0x1b873593
  let i = 0
  for (; i + 4 <= s.length; i += 4) {
    let k1 =
      s.charCodeAt(i) |
      (s.charCodeAt(i + 1) << 8) |
      (s.charCodeAt(i + 2) << 16) |
      (s.charCodeAt(i + 3) << 24)
    k1 = Math.imul(k1, c1)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, c2)
    h1 ^= k1
    h1 = (h1 << 13) | (h1 >>> 19)
    h1 = Math.imul(h1, 5) + 0xe6546b64
  }
  let k1 = 0
  const tail = s.length - i
  if (tail >= 3) k1 ^= s.charCodeAt(i + 2) << 16
  if (tail >= 2) k1 ^= s.charCodeAt(i + 1) << 8
  if (tail >= 1) {
    k1 ^= s.charCodeAt(i)
    k1 = Math.imul(k1, c1)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, c2)
    h1 ^= k1
  }
  h1 ^= s.length
  h1 ^= h1 >>> 16
  h1 = Math.imul(h1, 0x85ebca6b)
  h1 ^= h1 >>> 13
  h1 = Math.imul(h1, 0xc2b2ae35)
  h1 ^= h1 >>> 16
  return h1 >>> 0
}

/**
 * Compute `k` bit positions for the key, all in `[0, size)`. Uses the
 * Kirsch–Mitzenmacher double-hash trick over `(fnv1a, murmur3)`. We
 * coerce both 32-bit hashes through `BigInt` because `size` can in
 * principle exceed 32 bits.
 */
const positions = (
  bf: { readonly size: number; readonly hashCount: number },
  key: string,
): readonly bigint[] => {
  const sizeB = BigInt(bf.size)
  const a = BigInt(fnv1a(key))
  const b = BigInt(murmur3(key))
  const out: bigint[] = []
  for (let i = 0; i < bf.hashCount; i++) {
    const idx = (((a + BigInt(i) * b) % sizeB) + sizeB) % sizeB
    out.push(idx)
  }
  return out
}

export const empty = (size: number, hashCount: number): BloomFilter => {
  validate(size, hashCount)
  return { size, hashCount, bits: ZERO }
}

export const add = (bf: BloomFilter, key: string): BloomFilter => {
  let bits = bf.bits
  for (const idx of positions(bf, key)) bits |= ONE << idx
  return { size: bf.size, hashCount: bf.hashCount, bits }
}

export const contains = (bf: BloomFilter, key: string): boolean => {
  for (const idx of positions(bf, key)) {
    if (((bf.bits >> idx) & ONE) !== ONE) return false
  }
  return true
}

/**
 * Population count of bits set. Useful for measuring fill ratio in
 * tests and for tuning `(size, hashCount)`.
 */
export const popcount = (bf: BloomFilter): number => {
  let v = bf.bits
  let total = 0
  while (v > ZERO) {
    total += Number(v & ONE)
    v >>= ONE
  }
  return total
}
