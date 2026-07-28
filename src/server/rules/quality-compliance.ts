import { createHash } from "node:crypto";

/**
 * Pure date/evidence rules used by cosmetics quality-compliance workflows.
 *
 * Date policy:
 * - Inputs and outputs are calendar dates (`YYYY-MM-DD`), never local timestamps.
 * - Arithmetic uses UTC components so host timezone/DST cannot change a result.
 * - The federal-business-day calendar models the normal US Monday-Friday schedule
 *   and the nationwide holidays in 5 USC 6103. It does not attempt to predict
 *   one-off Executive Orders, emergency closures, state holidays, or the
 *   Washington-DC-only Inauguration Day.
 * - Juneteenth is included from 2021, when it became a federal holiday.
 *
 * These helpers calculate workflow deadlines and retention floors; they are not
 * a substitute for market-specific legal review.
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SATURDAY = 6;
const SUNDAY = 0;

interface UtcDateParts {
  year: number;
  month: number;
  day: number;
}

function makeUtcDate({ year, month, day }: UtcDateParts): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function parseIsoDate(value: string, field = "date"): Date {
  const match = ISO_DATE_RE.exec(value);
  if (!match) throw new RangeError(`${field} must be a YYYY-MM-DD date`);

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  if (parts.year === 0) throw new RangeError(`${field} year must be between 0001 and 9999`);

  const date = makeUtcDate(parts);
  if (
    date.getUTCFullYear() !== parts.year
    || date.getUTCMonth() + 1 !== parts.month
    || date.getUTCDate() !== parts.day
  ) {
    throw new RangeError(`${field} must be a real YYYY-MM-DD date`);
  }
  return date;
}

/** Strict calendar-date predicate for API/schema boundaries; never normalizes invalid dates. */
export function isRealIsoDate(value: string): boolean {
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

function formatIsoDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): Date {
  const first = makeUtcDate({ year, month, day: 1 });
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return makeUtcDate({ year, month, day: 1 + offset + ((nth - 1) * 7) });
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const firstOfNextMonth = month === 12
    ? makeUtcDate({ year: year + 1, month: 1, day: 1 })
    : makeUtcDate({ year, month: month + 1, day: 1 });
  const last = addUtcDays(firstOfNextMonth, -1);
  return addUtcDays(last, -((last.getUTCDay() - weekday + 7) % 7));
}

/** Standard observed date for a Monday-Friday federal work schedule. */
function observedFederalHoliday(actual: Date): Date {
  if (actual.getUTCDay() === SATURDAY) return addUtcDays(actual, -1);
  if (actual.getUTCDay() === SUNDAY) return addUtcDays(actual, 1);
  return new Date(actual.getTime());
}

function actualUsFederalHolidays(year: number): Date[] {
  const monday = 1;
  const thursday = 4;
  const holidays = [
    makeUtcDate({ year, month: 1, day: 1 }), // New Year's Day
    nthWeekdayOfMonth(year, 1, monday, 3), // Birthday of Martin Luther King, Jr.
    nthWeekdayOfMonth(year, 2, monday, 3), // Washington's Birthday
    lastWeekdayOfMonth(year, 5, monday), // Memorial Day
    makeUtcDate({ year, month: 7, day: 4 }), // Independence Day
    nthWeekdayOfMonth(year, 9, monday, 1), // Labor Day
    nthWeekdayOfMonth(year, 10, monday, 2), // Columbus Day
    makeUtcDate({ year, month: 11, day: 11 }), // Veterans Day
    nthWeekdayOfMonth(year, 11, thursday, 4), // Thanksgiving Day
    makeUtcDate({ year, month: 12, day: 25 }), // Christmas Day
  ];
  if (year >= 2021) {
    holidays.push(makeUtcDate({ year, month: 6, day: 19 })); // Juneteenth
  }
  return holidays;
}

/**
 * Observed dates for the statutory holidays belonging to `holidayYear`.
 *
 * An observed New Year's Day can fall on December 31 of the previous calendar
 * year. Callers checking one calendar date should use
 * `isUsFederalBusinessDay`, which handles this cross-year edge.
 */
export function usFederalObservedHolidays(holidayYear: number): string[] {
  if (!Number.isInteger(holidayYear) || holidayYear < 1 || holidayYear > 9999) {
    throw new RangeError("holidayYear must be an integer between 1 and 9999");
  }
  return [...new Set(
    actualUsFederalHolidays(holidayYear)
      .map(observedFederalHoliday)
      .map(formatIsoDate),
  )].sort();
}

/** Whether a date is a weekday that is not an observed nationwide federal holiday. */
export function isUsFederalBusinessDay(dateValue: string): boolean {
  const date = parseIsoDate(dateValue);
  if (date.getUTCDay() === SATURDAY || date.getUTCDay() === SUNDAY) return false;

  const year = date.getUTCFullYear();
  const observed = new Set(
    [year - 1, year, year + 1]
      .filter((holidayYear) => holidayYear >= 1 && holidayYear <= 9999)
      .flatMap(usFederalObservedHolidays),
  );
  return !observed.has(dateValue);
}

/**
 * Add federal business days, beginning with the day after `receivedDate`.
 *
 * This start-exclusive convention matches "no later than N business days after
 * receipt". Passing zero returns the received date unchanged.
 */
export function addUsFederalBusinessDays(receivedDate: string, businessDays: number): string {
  let cursor = parseIsoDate(receivedDate, "receivedDate");
  if (!Number.isInteger(businessDays) || businessDays < 0) {
    throw new RangeError("businessDays must be a non-negative integer");
  }

  let counted = 0;
  while (counted < businessDays) {
    cursor = addUtcDays(cursor, 1);
    if (isUsFederalBusinessDay(formatIsoDate(cursor))) counted += 1;
  }
  return formatIsoDate(cursor);
}

/** MoCRA serious-adverse-event submission deadline helper (21 USC 364a). */
export function add15UsFederalBusinessDays(receivedDate: string): string {
  return addUsFederalBusinessDays(receivedDate, 15);
}

/**
 * Add a calendar-year retention floor without shortening a leap-day period.
 *
 * A February 29 anniversary in a non-leap target year becomes March 1, rather
 * than February 28. The returned date is the final "retain through" calendar
 * date; purge eligibility belongs to a workflow and must be later than it.
 */
function addConservativeRetentionYears(startDate: string, years: number, field: string): string {
  const source = parseIsoDate(startDate, field);
  const targetYear = source.getUTCFullYear() + years;
  if (targetYear > 9999) throw new RangeError(`${field} retention date exceeds year 9999`);

  const target = makeUtcDate({
    year: targetYear,
    month: source.getUTCMonth() + 1,
    day: source.getUTCDate(),
  });
  return formatIsoDate(target);
}

/**
 * Conservative six-year adverse-event record floor.
 *
 * This deliberately does not apply MoCRA's qualifying-small-business three-year
 * exception; eligibility for that exception is a separate legal/business fact.
 */
export function adverseEventRetentionThrough(receivedDate: string): string {
  return addConservativeRetentionYears(receivedDate, 6, "receivedDate");
}

/** End of the one-year US serious-adverse-event follow-up monitoring window. */
export function adverseEventFollowUpThrough(receivedDate: string): string {
  return addConservativeRetentionYears(receivedDate, 1, "receivedDate");
}

/** NMPA cosmetics-GMP annual self-inspection report floor: not less than two years. */
export function gmpSelfInspectionRetentionThrough(reportDate: string): string {
  return addConservativeRetentionYears(reportDate, 2, "reportDate");
}

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalJsonInternal(value: CanonicalJsonValue, ancestors: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not allow non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("canonical JSON accepts only null, booleans, finite numbers, strings, arrays, and plain objects");
  }

  if (ancestors.has(value)) throw new TypeError("canonical JSON does not allow circular references");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError("canonical JSON does not allow sparse arrays");
        items.push(canonicalJsonInternal(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON accepts only plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("canonical JSON does not allow symbol keys");
    }

    const entries = Object.keys(value)
      // `<` is locale-independent UTF-16 code-unit order; localeCompare is not.
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("canonical JSON does not allow accessor properties");
        }
        return `${JSON.stringify(key)}:${canonicalJsonInternal(descriptor.value, ancestors)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Deterministic JSON text for immutable evidence.
 *
 * Object keys are recursively sorted and array order is preserved. Only genuine
 * JSON values are accepted; callers should encode decimals, large identifiers,
 * and dates as strings before hashing. Strings are preserved exactly—Unicode
 * normalization, when required by a source contract, must happen before this
 * function. This is intentionally a small internal contract, not an
 * implementation claim for RFC 8785/JCS interoperability.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  return canonicalJsonInternal(value, new WeakSet<object>());
}

/** Lowercase SHA-256 of `canonicalJson(value)`. */
export function canonicalJsonSha256(value: CanonicalJsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export type DueState = "not_due" | "due_soon" | "overdue" | "completed";

export interface DueStateInput {
  dueDate: string;
  /** Explicit evaluation date; the rule never reads the system clock. */
  asOfDate: string;
  /** Inclusive due-soon horizon, supplied by the owning workflow/policy. */
  dueSoonThroughDate: string;
  /** A completion after `asOfDate` does not rewrite the earlier as-of state. */
  completedDate?: string | null;
}

/**
 * Classify an obligation at an explicit as-of date.
 *
 * Boundaries: due before as-of = overdue; due on as-of through the inclusive
 * horizon = due soon; due after the horizon = not due. Completion wins only
 * when it occurred on or before the as-of date.
 */
export function classifyDueState(input: DueStateInput): DueState {
  parseIsoDate(input.dueDate, "dueDate");
  parseIsoDate(input.asOfDate, "asOfDate");
  parseIsoDate(input.dueSoonThroughDate, "dueSoonThroughDate");
  if (input.completedDate != null) parseIsoDate(input.completedDate, "completedDate");

  if (input.dueSoonThroughDate < input.asOfDate) {
    throw new RangeError("dueSoonThroughDate must be on or after asOfDate");
  }
  if (input.completedDate != null && input.completedDate <= input.asOfDate) return "completed";
  if (input.dueDate < input.asOfDate) return "overdue";
  if (input.dueDate <= input.dueSoonThroughDate) return "due_soon";
  return "not_due";
}
