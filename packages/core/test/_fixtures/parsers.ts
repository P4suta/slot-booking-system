/**
 * `Either.getOrThrow`-wrapped parsers, intended exclusively for test
 * fixtures where invalid inputs are programmer errors rather than
 * runtime conditions to handle. Production code uses the underlying
 * `parseX` directly and threads the `Either` through.
 */
import { Either } from "effect"
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

export const kana = (s: string): NameKana => Either.getOrThrow(parseNameKana(s))
export const phone = (s: string): PhoneLast4 => Either.getOrThrow(parsePhoneLast4(s))
export const freeText = (s: string): FreeText => Either.getOrThrow(parseFreeText(s))
export const bookingCode = (v: bigint): BookingCode => Either.getOrThrow(encodeBookingCode(v))
export const skill = (s: string): Skill => Either.getOrThrow(parseSkill(s))
export const resourceType = (s: string): ResourceType => Either.getOrThrow(parseResourceType(s))
export const businessTimeZone = (s: string): BusinessTimeZone =>
  Either.getOrThrow(parseBusinessTimeZone(s))
export const weekday = (n: number): Weekday => Either.getOrThrow(parseWeekday(n))
export const holdingDays = (n: number): HoldingDays => Either.getOrThrow(parseHoldingDays(n))
export const openWindow = (a: number, b: number): OpenWindow =>
  Either.getOrThrow(makeOpenWindow(t(a), t(b)))
