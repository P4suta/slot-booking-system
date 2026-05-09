import { reset } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { parseJson, worker } from "../_harness/httpFixture.js"
import * as req from "../_harness/sample-requests.js"

/**
 * Handle normalisation parity between IssueTicket and MyTicket.
 *
 * The customer-supplied `nameKana` runs through `normalizeNameKana`
 * (NFKC fold + whitespace collapse + trim) inside the branded
 * value-object. If only IssueTicket normalises and MyTicket compares
 * the raw query string, two queries with semantically equal kana
 * (e.g. trailing space, full-width ideographic space) hit a
 * `PhoneMismatch` 403 even though they identify the same ticket.
 *
 * These tests pin the boundary contract: the customer can re-fetch
 * with **any** raw form that normalises to the same canonical kana,
 * and the API directly rejects malformed `phoneLast4` at the
 * boundary (defense-in-depth: never let unbounded strings reach the
 * downstream comparator).
 */

afterEach(async () => {
  await reset()
})

const issueAndId = async (nameKana: string, phoneLast4: string): Promise<string> => {
  const issue = await worker().fetch(
    req.issueTicket({ handle: { nameKana, phoneLast4 }, freeText: null }),
  )
  expect(issue.status).toBe(201)
  const body = await parseJson<{ ticket: { id: string } }>(issue)
  return body.ticket.id
}

describe("handle normalisation parity", () => {
  it("trailing ASCII space on nameKana — myTicket re-fetch succeeds", async () => {
    const ticketId = await issueAndId("ヤマダ タロウ ", "1234")
    const res = await worker().fetch(
      req.myTicket({ ticketId, nameKana: "ヤマダ タロウ ", phoneLast4: "1234" }),
    )
    expect(res.status).toBe(200)
  })

  it("full-width ideographic space on nameKana — myTicket re-fetch succeeds", async () => {
    const ticketId = await issueAndId("ヤマダ　タロウ", "1234")
    const res = await worker().fetch(
      req.myTicket({
        ticketId,
        nameKana: "ヤマダ　タロウ",
        phoneLast4: "1234",
      }),
    )
    expect(res.status).toBe(200)
  })

  it("half-width katakana on nameKana — myTicket re-fetch succeeds", async () => {
    const ticketId = await issueAndId("ﾔﾏﾀﾞ ﾀﾛｳ", "1234")
    const res = await worker().fetch(
      req.myTicket({ ticketId, nameKana: "ﾔﾏﾀﾞ ﾀﾛｳ", phoneLast4: "1234" }),
    )
    expect(res.status).toBe(200)
  })
})

describe("HTTP boundary rejects malformed handle inputs (defense-in-depth)", () => {
  it("issueTicket: phoneLast4 with non-digits → 422 InvalidPhoneLast4", async () => {
    const res = await worker().fetch(
      req.issueTicket({
        handle: { nameKana: "ヤマダ タロウ", phoneLast4: "12ab" },
        freeText: null,
      }),
    )
    expect(res.status).toBe(422)
    const body = await parseJson<{ error: { _tag: string } }>(res)
    expect(body.error._tag).toBe("InvalidPhoneLast4")
  })

  it("issueTicket: phoneLast4 over 4 digits → 422 InvalidPhoneLast4", async () => {
    const res = await worker().fetch(
      req.issueTicket({
        handle: { nameKana: "ヤマダ タロウ", phoneLast4: "12345" },
        freeText: null,
      }),
    )
    expect(res.status).toBe(422)
    const body = await parseJson<{ error: { _tag: string } }>(res)
    expect(body.error._tag).toBe("InvalidPhoneLast4")
  })

  it("issueTicket: oversized nameKana (over 50 chars) → 422 InvalidNameKana", async () => {
    const res = await worker().fetch(
      req.issueTicket({
        handle: { nameKana: "ヤ".repeat(51), phoneLast4: "1234" },
        freeText: null,
      }),
    )
    expect(res.status).toBe(422)
    const body = await parseJson<{ error: { _tag: string } }>(res)
    expect(body.error._tag).toBe("InvalidNameKana")
  })

  it("myTicket: phoneLast4 non-digit at boundary → 422 (not 403)", async () => {
    const ticketId = await issueAndId("ヤマダ タロウ", "1234")
    const res = await worker().fetch(
      req.myTicket({ ticketId, nameKana: "ヤマダ タロウ", phoneLast4: "abcd" }),
    )
    expect(res.status).toBe(422)
  })

  it("myTicket: oversized nameKana → 422 (not 403)", async () => {
    const ticketId = await issueAndId("ヤマダ タロウ", "1234")
    const res = await worker().fetch(
      req.myTicket({
        ticketId,
        nameKana: "ヤ".repeat(200),
        phoneLast4: "1234",
      }),
    )
    expect(res.status).toBe(422)
  })

  it("cancelTicket: alphanumeric phoneLast4 → 422 InvalidPhoneLast4 at boundary", async () => {
    const ticketId = await issueAndId("ヤマダ タロウ", "1234")
    const res = await worker().fetch(
      req.cancelTicket(ticketId, {
        handle: { nameKana: "ヤマダ タロウ", phoneLast4: "abcd" },
        reason: "ng",
      }),
    )
    expect(res.status).toBe(422)
    const body = await parseJson<{ error: { _tag: string } }>(res)
    expect(body.error._tag).toBe("InvalidPhoneLast4")
  })
})
