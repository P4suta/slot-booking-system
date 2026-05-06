/**
 * Phase 2.7 / BI-12 — minimal i18n message resolver for booking
 * errors. The customer-facing UI surfaces a localised string for
 * every `BookingError._tag` returned by the API. The full
 * `paraglide-js` runtime (declared in `package.json` since Phase 0.11
 * but not yet wired) is overkill for this surface — the message set is
 * closed (one entry per `DomainError` tag) and the rendering happens
 * inside Svelte components that already manage their own DOM updates.
 *
 * Mapping is keyed on `BookingError.tag` (the `_tag` of the underlying
 * `DomainError`). The default locale is Japanese; English fallbacks
 * exist so a future `?lang=en` can flip without code changes.
 *
 * The `i18nKey` field on `BookingError` is the canonical lookup key
 * (`error.<_tag>`) emitted by the API; this map keys on the bare
 * `tag` for ergonomics — `lookup(error)` does the prefix work.
 */

type Locale = "ja" | "en"

type MessageMap = Readonly<Record<string, string>>

const ja: MessageMap = {
  // Validation
  InvalidPhoneLast4: "電話番号下4桁の形式が正しくありません",
  InvalidNameKana: "お名前(カナ)の形式が正しくありません",
  InvalidBookingCode: "予約コードの形式が正しくありません",
  InvalidFreeTextCharacter: "備考に使用できない文字が含まれています",
  InvalidFreeText: "備考の形式が正しくありません",
  InvalidDuration: "時間の指定が正しくありません",
  InvalidHoldingDays: "保留日数の指定が正しくありません",
  InvalidTimeSlot: "時間枠の指定が正しくありません",
  InvalidBitmap: "内部データの形式が正しくありません",
  InvalidSkill: "スキルの指定が正しくありません",
  InvalidResourceType: "リソース種別の指定が正しくありません",
  InvalidWeekday: "曜日の指定が正しくありません",
  InvalidOpenWindow: "営業時間枠の指定が正しくありません",
  InvalidAbsence: "休暇期間の指定が正しくありません",
  InvalidBusinessTimeZone: "タイムゾーンの指定が正しくありません",
  InvalidEntityId: "ID の形式が正しくありません",
  InvalidCatalogInput: "カタログ入力の形式が正しくありません",
  MissingStaffCapability: "スタッフ権限が確認できません",
  InvalidSlotToken: "枠の有効期限が切れたか、不正な枠です。再度検索してください",

  // Domain
  BookingNotFound: "予約が見つかりませんでした",
  PhoneMismatch: "電話番号下4桁が一致しません",
  AlreadyCancelled: "この予約はすでにキャンセル済みです",
  AlreadyCompleted: "この予約はすでに完了済みです",
  AlreadyNoShow: "この予約は無断欠席として記録されています",
  SlotExpired: "この枠は有効期限を過ぎています",
  SlotUnavailable: "この枠は予約できません",
  OutsideBusinessHours: "営業時間外です",
  ServiceDisabled: "このサービスは現在受付を停止しています",
  ProviderUnavailable: "担当者が予約できない状態です",
  ResourceUnavailable: "必要なリソースが空いていません",
  InvalidStateTransition: "この操作は現在の状態では実行できません",
  InsufficientCapability: "この操作を行う権限がありません",

  // Infrastructure
  AggregateNotFound: "予約データが見つかりませんでした",
  Concurrency: "他の操作と競合しました。再度お試しください",
  Storage: "サーバー側のエラーが発生しました。しばらくしてから再度お試しください",
}

const en: MessageMap = {
  InvalidPhoneLast4: "Phone last-4 digits are not in the expected format",
  InvalidNameKana: "Name (kana) is not in the expected format",
  InvalidBookingCode: "Booking code is not in the expected format",
  InvalidFreeTextCharacter: "The note contains characters that are not allowed",
  InvalidFreeText: "Note is not in the expected format",
  InvalidDuration: "Duration value is not valid",
  InvalidHoldingDays: "Holding-days value is not valid",
  InvalidTimeSlot: "Time slot is not valid",
  InvalidBitmap: "Internal data is not in the expected format",
  InvalidSkill: "Skill value is not valid",
  InvalidResourceType: "Resource type is not valid",
  InvalidWeekday: "Weekday is not valid",
  InvalidOpenWindow: "Open window is not valid",
  InvalidAbsence: "Absence period is not valid",
  InvalidBusinessTimeZone: "Time zone is not valid",
  InvalidEntityId: "Identifier is not in the expected format",
  InvalidCatalogInput: "Catalog input is not in the expected format",
  MissingStaffCapability: "Staff capability could not be verified",
  InvalidSlotToken: "The slot expired or is invalid. Please search again",

  BookingNotFound: "Booking not found",
  PhoneMismatch: "Phone last-4 digits do not match",
  AlreadyCancelled: "This booking has already been cancelled",
  AlreadyCompleted: "This booking has already been completed",
  AlreadyNoShow: "This booking is recorded as a no-show",
  SlotExpired: "This slot is past its expiry",
  SlotUnavailable: "This slot is not available",
  OutsideBusinessHours: "Outside business hours",
  ServiceDisabled: "This service is not currently accepting bookings",
  ProviderUnavailable: "The provider is not available",
  ResourceUnavailable: "A required resource is not available",
  InvalidStateTransition: "This operation cannot be performed in the current state",
  InsufficientCapability: "You do not have permission to perform this operation",

  AggregateNotFound: "Booking data not found",
  Concurrency: "Conflicted with another operation. Please try again",
  Storage: "A server-side error occurred. Please try again shortly",
}

const messagesByLocale: Readonly<Record<Locale, MessageMap>> = { ja, en }

type LocalisableError = {
  readonly tag: string
  readonly i18nKey?: string
  readonly message?: string
}

/**
 * Resolve a `BookingError` to a localised user-facing message.
 *
 * Lookup order:
 *   1. `messages[locale][error.tag]` — the explicit map above
 *   2. `error.message` — the GraphQL boundary's English fallback
 *   3. a generic "unexpected error" string in the active locale
 */
export const localiseBookingError = (error: LocalisableError, locale: Locale = "ja"): string => {
  const map = messagesByLocale[locale]
  if (Object.hasOwn(map, error.tag)) return map[error.tag]
  if (error.message !== undefined && error.message.length > 0) return error.message
  return locale === "ja" ? "予期しないエラーが発生しました" : "An unexpected error occurred"
}
