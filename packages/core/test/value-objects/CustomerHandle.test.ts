import { Result } from "effect"
import { describe, expect, it } from "vitest"
import {
  type CustomerHandle,
  equalsCustomerHandle,
  parseCustomerHandle,
} from "../../src/domain/value-objects/CustomerHandle.js"

const isRight = Result.isSuccess
const isLeft = Result.isFailure

const successOrThrow = (r: Result.Result<CustomerHandle, unknown>): CustomerHandle =>
  Result.isSuccess(r)
    ? r.success
    : (() => {
        throw new Error("expected success")
      })()

describe("parseCustomerHandle", () => {
  it("accepts a well-formed kana + 4-digit pair", () => {
    const r = parseCustomerHandle("ヤマダ タロウ", "1234")
    expect(isRight(r)).toBe(true)
  })

  it("rejects an invalid name (kanji)", () => {
    const r = parseCustomerHandle("山田 太郎", "1234")
    expect(isLeft(r)).toBe(true)
  })

  it("rejects an invalid phone (5 digits)", () => {
    const r = parseCustomerHandle("ヤマダ タロウ", "12345")
    expect(isLeft(r)).toBe(true)
  })

  it("returns the kana error first when both are invalid", () => {
    const r = parseCustomerHandle("xxx", "abc")
    expect(isLeft(r)).toBe(true)
    if (isLeft(r)) expect(r.failure._tag).toBe("InvalidNameKana")
  })
})

describe("equalsCustomerHandle", () => {
  it("equals on identical pairs", () => {
    const a = successOrThrow(parseCustomerHandle("ヤマダ タロウ", "1234"))
    const b = successOrThrow(parseCustomerHandle("ヤマダ タロウ", "1234"))
    expect(equalsCustomerHandle(a, b)).toBe(true)
  })

  it("differs on a different kana", () => {
    const a = successOrThrow(parseCustomerHandle("ヤマダ タロウ", "1234"))
    const b = successOrThrow(parseCustomerHandle("サトウ ジロウ", "1234"))
    expect(equalsCustomerHandle(a, b)).toBe(false)
  })

  it("differs on a different phone", () => {
    const a = successOrThrow(parseCustomerHandle("ヤマダ タロウ", "1234"))
    const b = successOrThrow(parseCustomerHandle("ヤマダ タロウ", "5678"))
    expect(equalsCustomerHandle(a, b)).toBe(false)
  })
})
