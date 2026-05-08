import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Pin the i18n message catalogue's two invariants:
 *
 * 1. **Locale parity** — `messages/ja.json` and `messages/en.json`
 *    have an identical key set. Adding a new key in one without the
 *    other is the most common paraglide drift, and it lands silently
 *    in production (the missing locale falls back to the key id, not
 *    a translation).
 * 2. **Error catalogue coverage** — every `_tag` listed in
 *    `docs/error-codes.md` (the registry-derived doc, drift-gated)
 *    has a `error_<Tag>` entry in both locales. paraglide's identifier-
 *    safe keys are underscore-flavoured (`error_InvalidPhoneLast4`),
 *    while `errorToI18nKey()` projects to the dot form
 *    (`error.<Tag>`); this test pins the underscore catalogue, which
 *    is what the page actually renders.
 */

const root = fileURLToPath(new URL("../..", import.meta.url))

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${root}${path}`, "utf-8")) as Record<string, unknown>

const readMd = (path: string): string => readFileSync(`${root}${path}`, "utf-8")

const ja = readJson("messages/ja.json")
const en = readJson("messages/en.json")
const errorCodesMd = readMd("../../docs/error-codes.md")

/**
 * Extract the `_tag` discriminator from each table row in
 * `docs/error-codes.md`. The doc layout is `| \`<Tag>\` |
 * \`<Code>\` | \`error.<Tag>\` |` — a single regex covers both the
 * validation, domain, and infrastructure sections.
 */
const errorTagRegex = /^\|\s+`([A-Z][A-Za-z0-9]+)`\s+\|\s+`E_/gm
const extractedTags = Array.from(errorCodesMd.matchAll(errorTagRegex), (m) => m[1])

const sortedKeys = (obj: Record<string, unknown>): readonly string[] =>
  Object.keys(obj)
    .filter((k) => !k.startsWith("$"))
    .sort()

describe("paraglide message catalogue parity (commit 13)", () => {
  it("ja and en catalogues have identical key sets", () => {
    expect(sortedKeys(ja)).toEqual(sortedKeys(en))
  })

  it("docs/error-codes.md exposes the expected number of tags", () => {
    // The catalogue is drift-gated against errorClassRegistry — the
    // count is part of the contract. If this assertion changes, the
    // i18n catalogue must follow.
    expect(extractedTags.length).toBeGreaterThanOrEqual(33)
  })

  it("every error_<Tag> from docs/error-codes.md exists in ja.json", () => {
    const missing = extractedTags.filter((tag) => !(`error_${tag}` in ja))
    expect(missing).toEqual([])
  })

  it("every error_<Tag> from docs/error-codes.md exists in en.json", () => {
    const missing = extractedTags.filter((tag) => !(`error_${tag}` in en))
    expect(missing).toEqual([])
  })

  it("ja.json carries the error_unknown fallback (UI default branch)", () => {
    expect(ja).toHaveProperty("error_unknown")
    expect(en).toHaveProperty("error_unknown")
  })

  it("no message key carries the literal placeholder string", () => {
    // Catches the inlang scaffold leaving "TODO" / "" in either locale.
    for (const [key, value] of Object.entries(ja)) {
      if (key.startsWith("$")) continue
      expect(value).not.toBe("")
      expect(value).not.toBe("TODO")
    }
    for (const [key, value] of Object.entries(en)) {
      if (key.startsWith("$")) continue
      expect(value).not.toBe("")
      expect(value).not.toBe("TODO")
    }
  })
})
