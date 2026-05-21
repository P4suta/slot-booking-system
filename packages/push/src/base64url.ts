/**
 * Workers runtime base64url codec.
 *
 * `Buffer` is not available on the Workers global; `btoa` / `atob`
 * are, but they only handle URL-safe base64 if we substitute the
 * padding manually. These two helpers wrap that bookkeeping so the
 * crypto callers stay focused on the protocol bytes.
 */

const PAD = "="
const BASE64URL_TO_BASE64: Record<string, string> = { "-": "+", _: "/" }
const BASE64_TO_BASE64URL: Record<string, string> = { "+": "-", "/": "_" }

const replaceAll = (s: string, table: Record<string, string>): string => {
  let out = ""
  for (const ch of s) {
    const swap = table[ch]
    out += swap ?? ch
  }
  return out
}

/** Encode bytes as URL-safe base64 (no padding). */
export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let bin = ""
  for (const b of bytes) {
    bin += String.fromCharCode(b)
  }
  const b64 = btoa(bin)
  // Strip trailing `=` padding and replace `+` / `/` with `-` / `_`.
  return replaceAll(b64.replace(/=+$/u, ""), BASE64_TO_BASE64URL)
}

/** Decode URL-safe base64 (no padding) to bytes. */
export const base64UrlToBytes = (b64url: string): Uint8Array => {
  const b64 = replaceAll(b64url, BASE64URL_TO_BASE64)
  // Re-attach padding to a multiple of 4 so `atob` does not reject.
  const padded = b64 + PAD.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

/** UTF-8 string → bytes shortcut. */
export const stringToBytes = (s: string): Uint8Array => new TextEncoder().encode(s)

/** bytes → UTF-8 string shortcut. */
export const bytesToString = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
