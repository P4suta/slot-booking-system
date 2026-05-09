import { readdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/*
 * ADR supersession marker invariant.
 *
 * Every ADR file whose body declares `superseded by ADR-NNNN` (or
 * `superseded by [ADR-NNNN]`) must also carry a grep-friendly
 * `Superseded-By: ADR-NNNN` line, so a `git grep "Superseded-By:"`
 * query finds every superseded ADR in one shot. The reverse
 * implication is checked too — the two forms cannot drift.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const adrDir = resolve(repoRoot, "docs", "adr")

const adrPaths = readdirSync(adrDir)
  .filter((f) => /^\d{4}-.*\.md$/.test(f))
  .map((f) => resolve(adrDir, f))

const SUPERSEDED_BY_RE = /superseded\s+by\s+(?:\[ADR-)?(\d{4})/i
const MARKER_RE = /Superseded-By:\s*ADR-(\d{4})/

const supersededBy = (body: string): RegExpExecArray | null => SUPERSEDED_BY_RE.exec(body)

const supersededByMarker = (body: string): RegExpExecArray | null => MARKER_RE.exec(body)

describe("ADR supersession invariant", () => {
  for (const path of adrPaths) {
    const body = readFileSync(path, "utf8")
    const sup = supersededBy(body)
    if (sup === null) continue
    const fileName = path.split("/").pop() ?? path
    it(`${fileName} pairs "superseded by" with "Superseded-By:"`, () => {
      const marker = supersededByMarker(body)
      expect(marker).not.toBeNull()
      expect(marker?.[1]).toBe(sup[1])
    })
  }

  it("every Superseded-By: marker is anchored by a 'superseded by' mention", () => {
    for (const path of adrPaths) {
      const body = readFileSync(path, "utf8")
      const marker = supersededByMarker(body)
      if (marker === null) continue
      const sup = supersededBy(body)
      expect(sup, `${path}: missing 'superseded by' for Superseded-By marker`).not.toBeNull()
    }
  })
})
