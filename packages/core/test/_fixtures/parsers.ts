/**
 * `Result.getOrThrow`-wrapped parsers, intended exclusively for test
 * fixtures where invalid inputs are programmer errors rather than
 * runtime conditions to handle. Production code uses the underlying
 * `parseX` directly and threads the `Result` through.
 */
import { Result } from "effect"
import { makeOpenWindow, type OpenWindow } from "../../src/domain/entities/OpenWindow.js"
import { parseWeekday, type Weekday } from "../../src/domain/entities/Weekday.js"
import { type BookingCode, encodeBookingCode } from "../../src/domain/value-objects/BookingCode.js"
import {
  type BusinessTimeZone,
  parseBusinessTimeZone,
} from "../../src/domain/value-objects/BusinessTimeZone.js"
import { type FreeText, parseFreeText } from "../../src/domain/value-objects/FreeText.js"
import { type HoldingDays, parseHoldingDays } from "../../src/domain/value-objects/HoldingDays.js"
import { type NameKana, parseNameKana } from "../../src/domain/value-objects/NameKana.js"
import { type PhoneLast4, parsePhoneLast4 } from "../../src/domain/value-objects/PhoneLast4.js"
import {
  parseResourceType,
  type ResourceType,
} from "../../src/domain/value-objects/ResourceType.js"
import { parseSkill, type Skill } from "../../src/domain/value-objects/Skill.js"
import { t } from "./instants.js"

export const kana = (s: string): NameKana => Result.getOrThrow(parseNameKana(s))
export const phone = (s: string): PhoneLast4 => Result.getOrThrow(parsePhoneLast4(s))
export const freeText = (s: string): FreeText => Result.getOrThrow(parseFreeText(s))
export const bookingCode = (v: bigint): BookingCode => Result.getOrThrow(encodeBookingCode(v))
export const skill = (s: string): Skill => Result.getOrThrow(parseSkill(s))
export const resourceType = (s: string): ResourceType => Result.getOrThrow(parseResourceType(s))
export const businessTimeZone = (s: string): BusinessTimeZone =>
  Result.getOrThrow(parseBusinessTimeZone(s))
export const weekday = (n: number): Weekday => Result.getOrThrow(parseWeekday(n))
export const holdingDays = (n: number): HoldingDays => Result.getOrThrow(parseHoldingDays(n))
export const openWindow = (a: number, b: number): OpenWindow =>
  Result.getOrThrow(makeOpenWindow(t(a), t(b)))
