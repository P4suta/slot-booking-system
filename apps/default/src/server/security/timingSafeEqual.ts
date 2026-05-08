/**
 * Constant-time byte-equality for two same-length string secrets,
 * implemented with WebCrypto-only primitives (Cloudflare Workers
 * runtime; no Node `crypto.timingSafeEqual` available). Uses a
 * single XOR fold so the loop body is data-independent at the
 * branch level — the early-return on length mismatch is the only
 * non-constant-time branch and runs *before* the secret reaches
 * the comparator.
 *
 * The prevailing `presented !== secret` form leaks length + prefix
 * via early-exit timing, which is enough to mount a Bleichenbacher-
 * style guess if an attacker can measure response timing
 * (CWE-208). Routing the staff capability check through this
 * helper closes the leak.
 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  // Workers' TextEncoder is always UTF-8; encode + length-mismatch
  // bail-out are not part of the constant-time guarantee (they happen
  // before the secret material is touched). The constant-time loop
  // runs over the encoded bytes.
  const enc = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  if (aBytes.byteLength !== bBytes.byteLength) return false
  let diff = 0
  for (let i = 0; i < aBytes.byteLength; i += 1) {
    // Each iteration ORs a byte-XOR into the accumulator — value-
    // independent: every iteration touches both arrays exactly
    // once and folds into `diff` regardless of equality at the
    // current index. `aBytes[i] ?? 0` reassures noUncheckedIndexed-
    // Access; the bounded loop guarantees the indices are valid.
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0)
  }
  return diff === 0
}
