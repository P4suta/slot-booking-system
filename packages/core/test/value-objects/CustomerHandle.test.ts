import { Result } from "effect"
import { describe, expect, it } from "vitest"
import {
  type CustomerHandle,
  equalsCustomerHandle,
  parseCustomerHandle,
  parseCustomerHandleStrict,
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

  it("accumulates both errors when kana and phone are both invalid", () => {
    const r = parseCustomerHandle("xxx", "abc")
    expect(isLeft(r)).toBe(true)
    if (isLeft(r)) {
      expect(r.failure).toHaveLength(2)
      expect(r.failure.map((e) => e._tag).sort()).toEqual(["InvalidNameKana", "InvalidPhoneLast4"])
    }
  })

  it("returns the success on the happy path", () => {
    const r = parseCustomerHandle("ヤマダ タロウ", "1234")
    expect(isRight(r)).toBe(true)
    if (isRight(r)) {
      expect(r.success.nameKana).toBe("ヤマダ タロウ")
      expect(r.success.phoneLast4).toBe("1234")
    }
  })
})

describe("parseCustomerHandleStrict (fail-fast)", () => {
  it("returns the kana error first when both are invalid", () => {
    const r = parseCustomerHandleStrict("xxx", "abc")
    expect(isLeft(r)).toBe(true)
    if (isLeft(r)) expect(r.failure._tag).toBe("InvalidNameKana")
  })

  it("returns the phone error when kana is valid", () => {
    const r = parseCustomerHandleStrict("ヤマダ タロウ", "abc")
    expect(isLeft(r)).toBe(true)
    if (isLeft(r)) expect(r.failure._tag).toBe("InvalidPhoneLast4")
  })

  it("succeeds on the happy path", () => {
    expect(isRight(parseCustomerHandleStrict("ヤマダ タロウ", "1234"))).toBe(true)
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
