/**
 * Single-shop deployment runs in JST. The slot picker translates
 * customer wall-clock picks to / from actual UTC instants using
 * this fixed offset (Asia/Tokyo has no DST so a constant is safe
 * year-round). Multi-tz deployments would replace this with a
 * Temporal.ZonedDateTime helper keyed off DEPLOYMENT_TIMEZONE.
 */
export const BUSINESS_TZ_OFFSET_MIN = 9 * 60
